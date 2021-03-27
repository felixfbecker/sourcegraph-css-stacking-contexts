import * as sourcegraph from 'sourcegraph'
import * as postscss from 'postcss-scss'
import debounce from 'lodash.debounce'
import dedent from 'dedent'
import { establishesStackingContext, isIneffectiveZIndexDeclaration } from './css'
import { nodeRange } from './helpers'

const DOCUMENT_SELECTOR: sourcegraph.DocumentSelector = [{ language: 'scss' }, { language: 'css' }]

const propertyInfoDecorationType = sourcegraph.app.createDecorationType()
const ruleHighlightDecorationType = sourcegraph.app.createDecorationType()
const warningDecorationType = sourcegraph.app.createDecorationType()

function documentFilePath(textDocument: sourcegraph.TextDocument): string {
    return new URL(textDocument.uri).hash.slice(1)
}

const getAllEditors = (): sourcegraph.ViewComponent[] =>
    sourcegraph.app.windows.flatMap(window => window.visibleViewComponents)

export function activate(context: sourcegraph.ExtensionContext): void {
    const allPropertyDecorations = new Map<string, sourcegraph.TextDocumentDecoration[]>()
    const allRuleDecorations = new Map<string, sourcegraph.TextDocumentDecoration[]>()
    const allWarningDecorations = new Map<string, sourcegraph.TextDocumentDecoration[]>()

    function decorate(editors: sourcegraph.ViewComponent[]): void {
        console.log('CSS Stacking Contexts: decorating editors', editors)
        for (const editor of editors) {
            try {
                if (editor.type !== 'CodeEditor') {
                    continue
                }

                const propertyDecorations: sourcegraph.TextDocumentDecoration[] = []
                const ruleDecorations: sourcegraph.TextDocumentDecoration[] = []
                const warningDecorations: sourcegraph.TextDocumentDecoration[] = []

                const text = editor.document.getText()
                if (!text) {
                    console.warn('No file content')
                    continue
                }

                // Parse CSS into AST
                const root = postscss.parse(text, { from: documentFilePath(editor.document) })

                // Walk all CSS declarations
                root.walkDecls(declaration => {
                    if (establishesStackingContext(declaration)) {
                        propertyDecorations.push({
                            range: nodeRange(declaration),
                            after: {
                                color: 'var(--text-muted)',
                                contentText: ' 📚 This property creates a new stacking context',
                            },
                            isWholeLine: true,
                        })
                        if (declaration.parent) {
                            const parentRange = nodeRange(declaration.parent)
                            // Sourcegraph only supports whole-range decorations atm
                            if (
                                !ruleDecorations.some(
                                    decoration => decoration.range.start.line === parentRange.start.line
                                )
                            ) {
                                for (let line = parentRange.start.line; line <= parentRange.end.line; line++) {
                                    ruleDecorations.push({
                                        range: new sourcegraph.Range(line, 0, line, 1),
                                        backgroundColor: 'var(--color-bg-4)',
                                        isWholeLine: true,
                                    })
                                }
                            }
                        }
                    }
                    if (isIneffectiveZIndexDeclaration(declaration)) {
                        warningDecorations.push({
                            range: nodeRange(declaration),
                            after: {
                                contentText:
                                    '⚠️ This `z-index` declaration does likely not have any effect because the rule does not create a new stacking context.',
                                linkURL:
                                    'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Positioning/Understanding_z_index/The_stacking_context',
                            },
                        })
                    }
                })

                editor.setDecorations(propertyInfoDecorationType, propertyDecorations)
                editor.setDecorations(ruleHighlightDecorationType, ruleDecorations)
                editor.setDecorations(warningDecorationType, warningDecorations)

                allPropertyDecorations.set(editor.document.uri, propertyDecorations)
                allRuleDecorations.set(editor.document.uri, ruleDecorations)
                allWarningDecorations.set(editor.document.uri, warningDecorations)
            } catch (error) {
                console.error(error)
            }
        }
    }
    const debouncedDecorate = debounce(decorate, 600, { maxWait: 1500, trailing: true })

    // Decorate whenever documents are opened or changed
    context.subscriptions.add(
        sourcegraph.workspace.openedTextDocuments.subscribe(document => {
            console.log('textDocument opened', document.uri)
            const editors = sourcegraph.app.windows
                .flatMap(window => window.visibleViewComponents)
                .filter(editor => editor.type === 'CodeEditor' && editor.document.uri === document.uri)
            debouncedDecorate(editors)
        })
    )

    debouncedDecorate(getAllEditors())

    // Listen to config toggle flag
    sourcegraph.configuration.subscribe(() => {
        if (sourcegraph.configuration.get().value['cssStackingContexts.showDecorations']) {
            debouncedDecorate(getAllEditors())
        } else {
            for (const editor of getAllEditors()) {
                if (editor.type === 'CodeEditor') {
                    editor.setDecorations(propertyInfoDecorationType, [])
                    editor.setDecorations(ruleHighlightDecorationType, [])
                    editor.setDecorations(warningDecorationType, [])
                }
            }
        }
    })

    // Show more information when hovering over the hint message decoration for properties creating stacking contexts
    context.subscriptions.add(
        sourcegraph.languages.registerHoverProvider(DOCUMENT_SELECTOR, {
            provideHover: (textDocument, position) => {
                const propertyDecorations = allPropertyDecorations.get(textDocument.uri.toString())
                if (!propertyDecorations) {
                    return null
                }
                // Check that hover was on a line with a "This property introduces a new stacking context" decoration
                const propertyDecoration = propertyDecorations.find(
                    ({ range }) =>
                        range.contains(position) ||
                        (range.start.line <= position.line && position.line <= range.end.line)
                )
                if (!propertyDecoration) {
                    return null
                }

                return {
                    range: propertyDecoration.range,
                    contents: {
                        kind: sourcegraph.MarkupKind.Markdown,
                        value: dedent`
                            This property introduces a new stacking context.
                            This means all \`z-index\` declarations for descendants of this element will be
                            independent of \`z-index\` declarations for other elements on the page.

                            The element itself will be positioned as one atomic unit on the z-axis inside the parent stacking context.

                            [Learn more on MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Positioning/Understanding_z_index/The_stacking_context)
                        `,
                    },
                }
            },
        })
    )
}
