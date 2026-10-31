// Real encrypted loopback integration. All Host state is disposable and synthetic.
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const runtimeRoot = process.env.NOVA_RUNTIME_BUILD_ROOT;
const relayRoot = process.env.NOVA_RELAY_BUILD_ROOT;
if (!runtimeRoot || !relayRoot) throw Error('compiled runtime and relay roots required');
const {RelayServer} = await import(pathToFileURL(`${relayRoot}/server.js`));
const {initializeHostSpace, loadSpaceHostController, readHostModelRoutes} =
  await import(pathToFileURL(`${runtimeRoot}/space-host/config.js`));
const {PersonalAgentHost} = await import(pathToFileURL(`${runtimeRoot}/personal-agent/host.js`));
const {SuggestionPool} = await import(pathToFileURL(`${runtimeRoot}/core/suggestions.js`));

const syntheticKey = 'phone-synthetic-secret-123';
const dir = await mkdtemp(join(await realpath(tmpdir()), 'nova-model-relay-'));
const configPath = join(dir, 'host.json');
const personalPath = join(dir, 'personal.json');
const envelopes = [];
const bootstrapToken = 'model-fixture-bootstrap-token-32';
const relay = new RelayServer({
  securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken,
  bind: '127.0.0.1', port: 0, requestsPerMinute: 10000,
  globalRequestsPerMinute: 20000,
  onMailbox: (_principal, envelope) => {envelopes.push(envelope);},
});
const relayUrl = await relay.listen();
let host, controller, pairing = false, stopping = false;

async function openHost() {
  host = new PersonalAgentHost({
    path: personalPath, userScope: 'model-settings-fixture',
    memory: () => undefined, pool: new SuggestionPool(), evidence: () => null,
  });
  await host.open({deferBackground: true});
  controller = await loadSpaceHostController(host, configPath, {});
  await controller.open();
}

async function inspect() {
  const client = controller.config.members[0]?.device;
  const journal = await readFile(configPath + '.journal.json', 'utf8');
  return {
    models: controller.modelsStatus(),
    persisted: readHostModelRoutes(configPath),
    secretMatches: controller.secrets.value('DEEPSEEK_API_KEY') === syntheticKey,
    snapshotContainsSecret: JSON.stringify(controller.service.snapshot(client)).includes(syntheticKey),
    journalContainsSecret: journal.includes(syntheticKey),
    phoneEnvelopeCount: envelopes.filter(envelope => envelope.from === client).length,
    wireContainsSecret: JSON.stringify(envelopes).includes(syntheticKey),
  };
}

await initializeHostSpace({configPath, personalPath, relayUrl, bootstrapToken});
await openHost();
console.log(JSON.stringify({invitation: await controller.invitation()}));
const timer = setInterval(async () => {
  if (pairing || stopping || controller.config.members.length) return;
  pairing = true;
  try {
    const pending = await controller.pairings();
    if (pending.length) await controller.confirmPairing(pending[0].id, pending[0].fingerprint);
  } catch (error) {console.error(error);}
  finally {pairing = false;}
}, 25);

async function close() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await controller?.close();
  await host?.close();
  await relay.close();
  await rm(dir, {recursive: true, force: true});
}
process.once('SIGTERM', () => {void close().then(() => process.exit(0));});

for await (const line of createInterface({input: process.stdin})) {
  const request = JSON.parse(line);
  try {
    if (request.method === 'local.configure') {
      await controller.configureModels({
        expected_version: request.expected_version,
        routes: {conversationText: {provider: 'deepseek', model: 'desktop-model'}},
      }, 'local-desktop-model-change');
    } else if (request.method === 'restart') {
      await controller.close();
      await host.close();
      await openHost();
    } else if (request.method !== 'inspect') throw Error('unknown_fixture_command');
    console.log(JSON.stringify({id: request.id, result: await inspect()}));
  } catch (error) {
    console.log(JSON.stringify({id: request.id, error: error.message}));
  }
}
await close();
