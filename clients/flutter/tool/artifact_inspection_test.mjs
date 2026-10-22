import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Execute both native templates without requiring a device or a WebView build.
const android = readFileSync(new URL('../android/app/src/main/kotlin/com/nova/nova_mobile/ArtifactWebContract.kt', import.meta.url), 'utf8')
  .match(/fun inspectionScript\(script: String\): String = """([\s\S]*?)"""/)[1];
const ios = readFileSync(new URL('../ios/Runner/ArtifactWebHost.swift', import.meta.url), 'utf8')
  .match(/let wrapped = """([\s\S]*?)"""/)[1];

for (const [platform, template] of [['Android', android], ['iOS', ios]]) {
  // Swift interpolates an encoded one-element array as the Function arguments.
  const swiftPlaceholder = String.raw`\(arguments)`;
  function inspect(body, errors = []) {
    const script = platform === 'iOS'
      ? template.replace(swiftPlaceholder, JSON.stringify([body]))
      : template.replace('${JSONObject.quote(script)}', JSON.stringify(body));
    let clicks = 0;
    const raw = runInNewContext(script, {
      window: { __novaPreviewErrors: errors },
      document: {
        title: 'Game',
        querySelector: () => ({ click() { clicks++; } }),
      },
    }, { timeout: 1000 });
    return { value: JSON.parse(raw), clicks };
  }

  test(`${platform}: synchronous DOM body returns actual observations`, () => {
    const { value, clicks } = inspect('document.querySelector("button").click(); return {title:document.title, checked:false};');
    assert.equal(clicks, 1);
    assert.deepEqual(value, { loaded: true, title: 'Game', errors: [], result: { title: 'Game', checked: false } });
  });

  test(`${platform}: wrappers, async and missing results fail with actionable errors`, () => {
    for (const [body, expected] of [
      ['function() { return new Promise(resolve => resolve({ok:true})); }', 'SyntaxError'],
      ['return Promise.resolve({ok:true});', 'async_test_script_unsupported'],
      ['return {then(){}};', 'async_test_script_unsupported'],
      ['(() => ({ok:true}));', 'invalid_test_result'],
      ['return () => true;', 'invalid_test_result'],
      ['return Symbol("ok");', 'invalid_test_result'],
      ['return {;', 'SyntaxError'],
      ['return {get then(){throw Error("then getter");}};', 'then getter'],
      ['const x={}; x.x=x; return x;', 'TypeError'],
      ['return 1n;', 'TypeError'],
    ]) {
      const { value } = inspect(body);
      assert.equal(value.loaded, true);
      assert.match(value.errors[0], new RegExp(expected));
      assert.equal('result' in value, false);
    }
  });

  test(`${platform}: quoted source and bounded exceptions retain page errors`, () => {
    assert.equal(inspect('return "quotes \\" \\\\ and \\\\n";').value.errors.length, 0);
    for (const text of ['line\u2028separator\u2029', '\ud800']) {
      assert.equal(inspect(`return ${JSON.stringify(text)};`).value.result, text);
    }
    const { value } = inspect('throw new Error("x".repeat(1000));', ['page failure']);
    assert.equal(value.errors[0], 'page failure');
    assert.equal(value.errors[1].length, 500);
    assert.equal(inspect('throw Error("check");', Array(20).fill('page')).value.errors.length, 20);
  });
}
