import { test, expect } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { clearField, moveBetweenFields } from "../src/form-editing.ts"

test("arrows traverse text before fields, including wrapped and scrolled rows", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 40, height: 24 })
  try {
    const inputs = ["abcdefghijklmno\n第二行\n第三行", "next", "", "last"].map((text, i) => {
      const input = new TextareaRenderable(renderer, { id: `field-${i}`, width: 8, height: 2, wrapMode: "char", initialValue: text })
      renderer.root.add(input)
      return input
    })
    await renderOnce()
    const first = inputs[0]!
    first.focus(); first.gotoBufferHome()
    expect(moveBetweenFields(inputs, 0, -1)).toBe(0)
    expect(moveBetweenFields(inputs, 0, 1)).toBe(0)
    expect(first.logicalCursor.row).toBe(0) // still inside a soft-wrapped logical line
    expect(first.logicalCursor.col).toBeGreaterThan(0)
    expect(moveBetweenFields(inputs, 0, 1)).toBe(0)
    expect(first.logicalCursor.row).toBe(1)
    first.gotoBufferEnd()
    await renderOnce()
    expect(first.scrollY).toBeGreaterThan(0)
    expect(moveBetweenFields(inputs, 0, -1)).toBe(0) // top visible row is not document top
    first.gotoBufferEnd()
    expect(moveBetweenFields(inputs, 0, 1)).toBe(1)
    expect(inputs[1]!.cursorOffset).toBe(0)
    expect(moveBetweenFields(inputs, 1, -1)).toBe(0)
    expect(first.logicalCursor.row).toBe(2)
    expect(moveBetweenFields(inputs, 2, 1)).toBe(3)
    expect(moveBetweenFields(inputs, 3, 1)).toBe(3) // no wrap from final field to first
    inputs[3]!.setText("第一行\n第二行")
    inputs[3]!.gotoBufferHome()
    expect(moveBetweenFields(inputs, 3, 1, true)).toBe(3) // still inside the final textarea
    expect(moveBetweenFields(inputs, 3, 1, true)).toBe(4) // the submit button
    expect(moveBetweenFields(inputs, 4, 1, true)).toBe(4)
    expect(moveBetweenFields(inputs, 4, -1, true)).toBe(3)
    expect(inputs[3]!.logicalCursor.row).toBe(1)
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
