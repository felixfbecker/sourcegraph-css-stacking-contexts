import { Node, Position } from 'postcss'
import * as sourcegraph from 'sourcegraph'

export const convertPosition = (position: Position): sourcegraph.Position =>
    new sourcegraph.Position(position.line - 1, position.column - 1)

export const nodeRange = (node: Node): sourcegraph.Range => {
    if (!node.source?.start || !node.source.end) {
        throw new Error('Node has no source position')
    }
    return new sourcegraph.Range(convertPosition(node.source.start), convertPosition(node.source.end))
}
