import { test, expect } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { clearField, moveBetweenFields } from "../src/form-editing.ts"

test("single textarea traverses wrapped and scrolled text before reaching the submit button", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 40, height: 24 })
  try {
    const input = new TextareaRenderable(renderer, { id: "prompt", width: 8, height: 2, wrapMode: "char", initialValue: "abcdefghijklmno\n第二行\n第三行" })
    renderer.root.add(input)
    const inputs = [input]
    await renderOnce()
    input.focus(); input.gotoBufferHome()
    expect(moveBetweenFields(inputs, 0, -1, true)).toBe(0)
    expect(moveBetweenFields(inputs, 0, 1, true)).toBe(0)
    expect(input.logicalCursor.row).toBe(0)
    expect(input.logicalCursor.col).toBeGreaterThan(0)
    expect(moveBetweenFields(inputs, 0, 1, true)).toBe(0)
    expect(input.logicalCursor.row).toBe(1)
    input.gotoBufferEnd()
    await renderOnce()
    expect(input.scrollY).toBeGreaterThan(0)
    expect(moveBetweenFields(inputs, 0, -1, true)).toBe(0)
    input.gotoBufferEnd()
    expect(moveBetweenFields(inputs, 0, 1, true)).toBe(1)
    expect(moveBetweenFields(inputs, 1, 1, true)).toBe(1)
    expect(moveBetweenFields(inputs, 1, -1, true)).toBe(0)
    expect(input.logicalCursor.row).toBe(2)
    input.setText("")
    expect(moveBetweenFields(inputs, 0, 1, true)).toBe(1)
    expect(moveBetweenFields(inputs, 1, -1, true)).toBe(0)
  } finally { renderer.destroy() }
})

test("clear is one undoable operation; undo also preserves previous typing history", async () => {
  const { renderer } = await createTestRenderer({ width: 40, height: 24 })
  try {
    const input = new TextareaRenderable(renderer, { id: "edit", initialValue: "中文🙂\n原内容" })
    renderer.root.add(input)
    input.gotoBufferEnd(); input.insertText(" 新输入")
    const before = input.plainText
    clearField(input)
    expect(input.plainText).toBe("")
    clearField(input) // clearing an empty field must not add another undo point
    input.undo()
    expect(input.plainText).toBe(before)
    input.undo()
    expect(input.plainText).toBe("中文🙂\n原内容")
  } finally { renderer.destroy() }
})
