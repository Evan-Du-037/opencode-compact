import type { TextareaRenderable } from "@opentui/core"

/** Move within wrapped/scrolled text first; cross fields only at a document boundary. */
export function moveBetweenFields(inputs: TextareaRenderable[], index: number, direction: -1 | 1, includeSubmit = false): number {
  if (includeSubmit && index === inputs.length) {
    if (direction < 0 && inputs.length) {
      inputs.at(-1)!.focus(); inputs.at(-1)!.gotoBufferEnd()
      return inputs.length - 1
    }
    return index
  }
  const input = inputs[index]
  if (!input) return index
  const row = input.visualCursor.visualRow + input.scrollY
  const boundary = direction < 0 ? row === 0 : row >= input.editorView.getTotalVirtualLineCount() - 1
  const target = index + direction
  if (includeSubmit && boundary && target === inputs.length) {
    input.blur()
    return target
  }
  if (boundary && inputs[target]) {
    inputs[target]!.focus()
    if (direction > 0) inputs[target]!.gotoBufferHome()
    else inputs[target]!.gotoBufferEnd()
    return target
  }
  if (direction < 0) input.moveCursorUp()
  else input.moveCursorDown()
  return index
}

export function clearField(input?: TextareaRenderable): void {
  // clear()/setText() discard undo history; replaceText() records a single undo point.
  if (input?.plainText) { input.clearSelection(); input.replaceText("") }
}
