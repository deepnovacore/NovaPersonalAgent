import assert from 'node:assert/strict'
import {test} from 'node:test'
import {codePointLengthLikePython, collapsePythonWhitespace, stripLikePython} from '../src/text/python-text.js'

test('text helpers preserve Python whitespace disagreements and astral code-point length', () => {
  assert.equal(stripLikePython('\u001c\u001d\u001e\u001f\u0085value\u0085'), 'value')
  assert.equal(stripLikePython('\ufeffvalue\ufeff'), '\ufeffvalue\ufeff')
  assert.equal(codePointLengthLikePython('A😀B'), 3)
  assert.equal('A😀B'.length, 4)
  assert.equal(collapsePythonWhitespace('\u001c\u0085\ufeffx\ufeff'), ' \ufeffx\ufeff')
})
