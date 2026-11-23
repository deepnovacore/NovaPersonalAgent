import {createSpaceHostPanel} from './space-host-panel.mjs'
import {NATIVE_VOICE_PROVIDERS} from './native-voice.mjs'
import {renderSkillsPage} from './skills-page.mjs'
import {createChatGptPanel} from './chatgpt-panel.mjs'
import {COMPATIBLE_STAGES, COMPATIBLE_FIELDS, COMPATIBLE_PRESETS, isEndpointSecret} from './compatible-providers.mjs'
import {mountPermissionCards} from './welcome-permissions.mjs'
import {createSkinPanel} from './skin-panel.mjs'
import {SELF_HOSTED_STAGES, endpointOrigin} from './voice-preset.mjs'
import {onButton} from './button-action.mjs'
import {createVoiceprintPanel} from './voiceprint-panel.mjs'
import {createStartupNotice, startupMessage} from './startup-notice.mjs'
import {createImPanel} from './im-panel.mjs'
import {createConnectionsPanel} from './connections-panel.mjs'
import {createProactivityPanel, memoryEmbeddingNote} from './proactivity-panel.mjs'
import {t, currentLanguage} from './locale.mjs'
import {readDisplayPreferences, subscribeDisplayPreferences, writeDisplayPreferences} from './view-preferences.mjs'
import {installIconSprite, icon} from './icon-sprite.mjs'
import {localizeDocument} from './locale.mjs'
localizeDocument(document)
// Install the shared sprite before any panel renders an icon; the call is
// idempotent, so lazy installs from iconNode() later stay no-ops.
installIconSprite(document)
import {frontendUsageText, renderFrontendUsage} from './frontend-usage.mjs'
import {createCapabilitiesEditor, moduleStatusNote} from './capabilities-editor.mjs'
import {createKnowledgePanel} from './knowledge-panel.mjs'
// Settings are edited as one local transaction. Public drafts live in the
// controller; secret plaintext remains only in password inputs until Save.
import {
  codexModeVisibility,
  createSettingsController,
  settingsButtonState,
} from './settings-controller.mjs'
import { createSecretRevisions } from './secret-revisions.mjs'
import {
  SETTINGS_CATEGORIES,
  categoryTabForKey,
  isValidCategory,
  resolveCategory,
} from './settings-categories.mjs'
import {
  CUSTOM_VOICE_VALUE,
  QWEN_VOICES,
  QWEN_31_VOICES,
  STEPFUN_VOICES,
  VOLCENGINE_TTS_VOICES,
  resolveVoiceChoice,
} from './voice-choice.mjs'

createChatGptPanel(document,window.novaPersonalAgentDesktop.chatgpt)
const api = window.novaPersonalAgentDesktop.settings
const skillsState={skills:null,loading:false,error:'',query:''}
const skillElement=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
function renderSettingsSkills(){
 const panel=document.querySelector('#skills-panel'),search=panel.querySelector('.skills-search'),focused=search===document.activeElement,selection=focused?[search.selectionStart,search.selectionEnd]:null;panel.replaceChildren()
 renderSkillsPage(panel,{el:skillElement,button:(label,action,parent)=>{const node=skillElement('button',label);node.type='button';node.addEventListener('click',()=>void action());parent.append(node);return node},state:skillsState,refresh:async()=>{
  skillsState.loading=true;skillsState.error='';renderSettingsSkills()
  try{const view=await api.get();skillsState.skills=Array.isArray(view?.skills)?view.skills:null;if(!skillsState.skills)skillsState.error='暂时无法读取技能，请稍后刷新。'}catch{skillsState.error='暂时无法读取技能，请稍后刷新。'}finally{skillsState.loading=false;renderSettingsSkills()}
 }})
 if(focused){const next=panel.querySelector('.skills-search');next.focus();if(selection?.every(Number.isInteger))next.setSelectionRange(...selection)}
}
const welcomeApi=window.novaPersonalAgentDesktop.welcome
let permissionsLoad=()=>{}
if(welcomeApi){
 const permissions=mountPermissionCards(document.querySelector('#desktop-permissions-panel'),{api:welcomeApi})
 const update=value=>permissions.update(value.permissions)
 const load=()=>welcomeApi.get().then(update).catch(()=>{})
 permissionsLoad=load
 welcomeApi.onChanged(update);window.addEventListener('focus',()=>void load());void load()
}
const imPanel = createImPanel({document, api})
const connectionsPanel = createConnectionsPanel({document, api})
const spaceHostPanel = createSpaceHostPanel({document, api})
let currentView = null
const proactivityPanel = createProactivityPanel({document, api, moduleStatusNote, rankFallback: () => {
  if (!currentView?.secretsPresent) return null
  return {keyMissing: currentView.secretsPresent.openrouterApiKey !== true}
}})
const diaryPanel = createProactivityPanel({document, api, moduleStatusNote, rootSelector: '#diary-panel', errorSelector: '#diary-error', parts: ['diary', 'brief']})
const voiceprintPanel = createVoiceprintPanel({document, api, stage: patch => controller.stage(patch)})
const SECRET_KEYS = [
  'minicpmRealtimeApiKey','personaplexRealtimeApiKey',
  'openaiCompatibleApiKey',
  'compatibleAsrApiKey',
  'compatibleTtsApiKey',
  'selfHostedAsrApiKey',
  'selfHostedLlmApiKey',
  'selfHostedTtsApiKey',
  'composioApiKey',
  'dashscopeApiKey', 'stepfunApiKey', 'tavilyApiKey', 'openrouterApiKey',
  'arkApiKey', 'deepseekApiKey', 'openaiApiKey', 'geminiApiKey', 'doubaoBigmodelApiKey',
]
const SECRET_LABELS = {
  minicpmRealtimeApiKey:'MiniCPM-o', personaplexRealtimeApiKey:'PersonaPlex',
  openaiCompatibleApiKey: 'OpenAI-compatible LLM',
  compatibleAsrApiKey: 'OpenAI-compatible ASR',
  compatibleTtsApiKey: 'OpenAI-compatible TTS',
  selfHostedAsrApiKey: 'Self-hosted ASR',
  selfHostedLlmApiKey: 'Self-hosted LLM',
  selfHostedTtsApiKey: 'Self-hosted TTS',
  composioApiKey: 'Composio',
  dashscopeApiKey: 'DashScope',
  stepfunApiKey: 'StepFun',
  openaiApiKey: 'OpenAI',
  geminiApiKey: 'Google Gemini',
  tavilyApiKey: 'Tavily',
  openrouterApiKey: 'OpenRouter · Jev',
  arkApiKey: 'Ark',
  deepseekApiKey: t("DeepSeek（官方）"),
  doubaoBigmodelApiKey: t("火山语音"),
}
const WORKSPACE_STATUS_TEXT = Object.freeze({
  opened: t("已打开当前工作区"),
  open_failed: t("系统未能打开当前工作区"),
  cleared: t("已清空工作区"),
  cancelled: t("已取消"),
  not_managed: t("当前工作区不在 Nova 工作区根目录中"),
  empty: t("没有可清空的工作区"),
  busy: t("另一项保存或维护操作正在进行"),
  stop_failed: t("后台未能安全停止，未清空工作区"),
  clear_failed: t("工作区清空未完整完成，可重试清理"),
  restart_failed: t("工作区已处理，但后台恢复失败，请重试连接"),
  clear_and_restart_failed: t("工作区清理未完整完成，后台恢复也失败；请重启后重试清理"),
  rollback_pending: t("工作区原内容尚未安全恢复，后台保持停止；请先处理回滚"),
  cleanup_pending: t("工作区清理仍在进行，请稍后重试"),
  unavailable: t("工作区维护状态暂时不可用"),
  recovered: t("工作区恢复完成，后台已开始重新连接"),
  recovery_failed: t("工作区恢复尚未完成，后台保持停止；请重试恢复"),
})

const secretRevisions = createSecretRevisions(SECRET_KEYS)
const dirtySecretKeys = new Set()
const nativeVoices = new Map()
let controllerState = {dirty: false, busy: false}
let workspaceBusy = false

const statusLabel = document.querySelector('#status')
const restartNotice = document.querySelector('#restart-notice')
const warning = document.querySelector('#keyring-warning')
const settingsRestore = document.querySelector('#settings-restore')
const settingsSave = document.querySelector('#settings-save')
const settingsRestart = document.querySelector('#settings-restart')
let restarting = false
const workspaceOpenCurrent = document.querySelector('#workspace-open-current')
const workspaceClearCurrent = document.querySelector('#workspace-clear-current')
const workspaceClearAll = document.querySelector('#workspace-clear-all')
const startupNotice = createStartupNotice({render: text => { document.querySelector('#startup-status').textContent = text }})
const workspaceRetryRecovery = document.querySelector('#workspace-retry-recovery')
const workspaceActionStatus = document.querySelector('#workspace-action-status')
const wakeEnabled = document.querySelector('#wake-word-enabled')
const autoHideSeconds = document.querySelector('#auto-hide-seconds')
const wakeStatus = document.querySelector('#wake-word-status')
const wakeRetry = document.querySelector('#wake-word-retry')
const codingProgressNarrationInput = document.querySelector('#coding-progress-narration')
const proactivityInputs = [...document.querySelectorAll('input[name="proactivity"]')]
const pipelineModeInputs = [...document.querySelectorAll('input[name="pipelineMode"]')]
const codexApprovalModeInputs = [...document.querySelectorAll('input[name="codexApprovalMode"]')]
const generatePlanInput = document.querySelector('#generatePlan')
const profileParticipantMessagesInput = document.querySelector('#profileParticipantMessages')
const planReadbackInputs = [...document.querySelectorAll('input[name="planReadback"]')]
const progressBubblesInputs = [...document.querySelectorAll('input[name="progressBubbles"]')]
const heartbeat = document.querySelector('#heartbeat')
const heartbeatValue = document.querySelector('#heartbeat-value')
const codexModeInputs = [...document.querySelectorAll('input[name="codexBinaryMode"]')]
const codexBinaryPath = document.querySelector('#codexBinaryPath')
const codexStatus = document.querySelector('#codex-status')
const codingProvider = document.querySelector('#coding-provider')
const codingPermissionNote = document.querySelector('#coding-permission-note')
const codingAcpSettings = document.querySelector('#coding-acp-settings')
const codingBinaryPath = document.querySelector('#coding-binary-path')
const codingConfigPath = document.querySelector('#coding-config-path')
// [title, native config label or '', setup guidance]; Codex keeps its own discovery controls.
const CODING_GUIDANCE = {
  opencode: ['OpenCode', '配置文件', '安装 opencode-ai，并用 OpenCode 自己的登录或配置文件设置模型与凭据。'],
  codebuddy: ['CodeBuddy', '', '安装 @tencent-ai/codebuddy-code，并在 CodeBuddy 命令行中完成登录或密钥配置。'],
  pi: ['Pi', '配置目录', '安装 Pi 与 pi-acp，并在 Pi 自己的配置中设置模型与登录。Pi 不支持逐项审批，询问模式下任务会被拒绝。'],
  deepseek: ['DeepSeek Harness', '配置目录', '安装 @deepseek-ai/dsh，并在其配置中设置凭据；也可以使用服务配置里的 DeepSeek API Key。'],
}
const yoloWarning = document.querySelector('#codex-yolo-warning')
const codexManualSettings = document.querySelector('#codex-manual-settings')
const codexRescan = document.querySelector('#codex-rescan')
const codexWorkspace = document.querySelector('#codexWorkspace')
const codexManagedRoot = document.querySelector('#codexManagedRoot')
const effectiveWorkspace = document.querySelector('#effective-workspace')
const effectiveManagedRoot = document.querySelector('#effective-managed-root')
const dataRootNotice = document.querySelector('#data-root-notice')
const integratedSection = document.querySelector('#integrated-pipeline')
const cascadedSection = document.querySelector('#cascaded-pipeline')
const integratedProvider = document.querySelector('#integratedProvider')
const integratedModel = document.querySelector('#integratedModel')
const integratedVoicePreset = document.querySelector('#integratedVoicePreset')
const integratedVoiceCustom = document.querySelector('#integratedVoiceCustom')
const geminiAsrModel = document.querySelector('#geminiAsrModel')
const geminiTtsModel = document.querySelector('#geminiTtsModel')
const GEMINI_TTS_VOICES = ['Kore','Puck','Aoede','Charon','Fenrir'].map(value=>({value,label:value}))
const cascadedAsrProvider = document.querySelector('#cascadedAsrProvider')
const cascadedLlmProvider = document.querySelector('#cascadedLlmProvider')
const cascadedLlmModelPreset = document.querySelector('#cascadedLlmModelPreset')
const cascadedLlmModel = document.querySelector('#cascadedLlmModel')
const cascadedTtsProvider = document.querySelector('#cascadedTtsProvider')
const cascadedTtsVoicePreset = document.querySelector('#cascadedTtsVoicePreset')
const cascadedTtsVoiceCustom = document.querySelector('#cascadedTtsVoiceCustom')
const clarificationDepth = document.querySelector('#clarificationDepth')
const displaySteps = document.querySelector('#display-steps')
const displayCollapse = document.querySelector('#display-collapse')
const buildReasoningInput = document.querySelector('#buildReasoning')

// Display preferences are per-machine UI state, not host settings: they take
// effect at once and never join the save payload. The settings window is the
// writer; an open workbench follows the storage event or the same-window event.
function renderDisplayPreferences(preferences) {
  displaySteps.value = preferences.steps
  displayCollapse.value = preferences.collapse
}
renderDisplayPreferences(readDisplayPreferences())
subscribeDisplayPreferences(renderDisplayPreferences)
displaySteps.addEventListener('change', () => writeDisplayPreferences({steps: displaySteps.value}))
displayCollapse.addEventListener('change', () => writeDisplayPreferences({collapse: displayCollapse.value}))

const categoryButtons = SETTINGS_CATEGORIES.map(category => document.querySelector(`#category-${category.id}`))
// One glyph per sidebar category, injected at boot so the static nav stays
// text-only (readable without JS) while the sprite owns all icon geometry.
const NAV_GLYPHS = Object.freeze({
  general: 'gear', diary: 'calendar', themes: 'theme', usage: 'chart',
  models: 'cube', skills: 'folder', capabilities: 'plus', mcp: 'plus', connectors: 'chat',
  permissions: 'lock', privacy: 'shield', knowledge: 'book', secrets: 'key',
  hub: 'monitor', phone: 'phone', codex: 'code',
})
for (const [index, button] of categoryButtons.entries()) {
  const category = button?.dataset?.category ?? SETTINGS_CATEGORIES[index].id
  const glyph = icon(NAV_GLYPHS[category] ?? 'gear', {document, size: 18})
  if (glyph) button.prepend(glyph)
}
{
  const rescanGlyph = icon('refresh', {document, size: 18})
  if (rescanGlyph) codexRescan.append(rescanGlyph)
}
let activeCategory = SETTINGS_CATEGORIES[0].id
const skinPanel = createSkinPanel({document, stage: patch => controller.stage(patch), discard: () => controller.discardFields(['skinId', 'importedSkins'])})
window.addEventListener('beforeunload', () => skinPanel.destroy(), {once: true})

// Sections are addressed by id from the category table rather than by a markup
// attribute, so showing a category never depends on document order.
function applyCategory(id) {
  if (!isValidCategory(id)) return
  const requested = id
  id = resolveCategory(id)
  if (id === 'models' && requested === 'pipeline') modelPane = 'pipeline'
  activeCategory = id
  if (id === 'skills') renderSettingsSkills()
  if (id === 'connectors') { void imPanel.load(); void connectionsPanel.load(); void spaceHostPanel.load() }
  if (id === 'permissions') void permissionsLoad()
  if (id === 'general') void proactivityPanel.load()
  if (id === 'diary') void diaryPanel.load()
  for (const category of SETTINGS_CATEGORIES) {
    const visible = category.id === id
    for (const sectionId of category.sections) {
      const section = document.getElementById(sectionId)
      if (section) section.hidden = !visible
    }
  }
  if (id === 'models') applyModelPane(modelPane)
  for (const [index, button] of categoryButtons.entries()) {
    const selected = SETTINGS_CATEGORIES[index].id === id
    button.setAttribute('aria-current', selected ? 'true' : 'false')
    button.tabIndex = selected ? 0 : -1
  }
}

for (const [index, button] of categoryButtons.entries()) {
  const id = SETTINGS_CATEGORIES[index].id
  button.addEventListener('click', () => { applyCategory(id) })
  button.addEventListener('keydown', event => {
    const next = categoryTabForKey(activeCategory, event.key)
    if (next === null) return
    event.preventDefault()
    applyCategory(next)
    document.querySelector(`#category-${next}`).focus?.()
  })
}

const capabilityEditor = createCapabilitiesEditor({root: document.querySelector('#capabilities-editor'),
  codingRoot: document.querySelector('#coding-executor-toggle'),
  problemsLabel: document.querySelector('#capabilities-problems'),
  stage: patch => controller.stage(patch), probe: payload => api.probeCapabilities(payload)})
const memoryPrerecall = document.getElementById('memory-prerecall-enabled')
document.getElementById('coding-executor-configure').addEventListener('click', () => {
  applyCategory('codex')
  document.getElementById('codex-projects').open = true
})
const capabilitySettings = ['embeddingProvider', 'embeddingModel', 'knowledgePath', 'capabilitiesConfigPath'].map(key => document.getElementById(key))
const knowledgePanel = createKnowledgePanel({document, action: payload => api.knowledgeAction(payload)})

function populatePresetOptions(select, presets, customLabel = t("自定义音色 ID…")) {
  select.replaceChildren()
  for (const preset of presets) {
    const option = document.createElement('option')
    option.value = preset.value
    option.textContent = preset.label
    select.append(option)
  }
  const custom = document.createElement('option')
  custom.value = CUSTOM_VOICE_VALUE
  custom.textContent = customLabel
  select.append(custom)
}

populatePresetOptions(integratedVoicePreset, QWEN_VOICES)
populatePresetOptions(cascadedTtsVoicePreset, VOLCENGINE_TTS_VOICES)

const secretTabs = ['models', 'connections']
function selectSecretTab(selected) {
  for (const id of secretTabs) {
    const tab = document.querySelector(`#secret-tab-${id}`)
    tab.setAttribute('aria-selected', String(id === selected))
    tab.tabIndex = id === selected ? 0 : -1
    document.querySelector(`#secret-panel-${id}`).hidden = id !== selected
  }
}
for (const id of secretTabs) {
  const tab = document.querySelector(`#secret-tab-${id}`)
  tab.addEventListener('click', () => selectSecretTab(id))
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? secretTabs[0] : event.key === 'End' ? secretTabs[1] : secretTabs.find(other => other !== id)
    selectSecretTab(next)
    document.querySelector(`#secret-tab-${next}`).focus()
  })
}

function secretInput(key) { return document.querySelector(`#${key}`) }
function secretClearButton(key) { return document.querySelector(`button.clear[data-key="${key}"]`) }

function renderBadges(present, sources) {
  for (const key of SECRET_KEYS) {
    const badge = document.querySelector(`#badge-${key}`)
    const stored = present?.[key] === true
    const fromFile = sources?.[key] === 'dotenv' && !isEndpointSecret(key)
    const fromEnvironment = sources?.[key] === 'environment'
    // A staged edit shows immediately: clearing says so before the save lands, and typing says the new value is not saved yet.
    const staged = dirtySecretKeys.has(key)
    const stagedValue = staged ? secretInput(key).value : ''
    badge.textContent = staged ? (stagedValue === '' ? t("将清除（保存后生效）") : t("待保存"))
      : fromFile ? t("来自 .env") : stored ? (fromEnvironment ? t("来自系统环境变量") : t("已设置")) : t("未设置")
    secretInput(key).hidden = stored && !dirtySecretKeys.has(key)
    secretInput(key).disabled = fromFile
    secretClearButton(key).disabled = fromFile
    secretClearButton(key).title = fromFile ? t("此密钥由 .env 管理，请在文件中清除并重启")
      : fromEnvironment ? t("此密钥来自系统环境变量，清除这里保存的值后仍会使用环境变量；需在启动环境中移除") : t("清除并输入新密钥")
    secretInput(key).placeholder = fromFile ? t("在 repo .env 中修改，重启后生效") : t("输入新密钥")
    badge.dataset.present = stored ? '1' : '0'
    badge.dataset.staged = staged ? '1' : '0'
  }
}

const TEST_RESULT_TEXT = Object.freeze({
  ok: t("密钥有效"),
  rejected: t("密钥被拒绝，请检查是否复制完整、是否已停用"),
  forbidden: t("密钥有效，但这个账号无权使用该服务"),
  network: t("暂时无法连接服务，请检查网络后重试"),
  missing: t("请先输入或保存密钥"),
  unreadable: t("无法读取已保存的密钥，请重新输入"),
  unsupported: '',
})
function testResultNode(key) { return document.querySelector(`#test-result-${key}`) }
async function testSecret(key) {
  const button = document.querySelector(`button.test[data-key="${key}"]`), result = testResultNode(key)
  if (!button || !result) return
  button.disabled = true
  result.dataset.status = 'testing'
  result.textContent = t("测试中…")
  try {
    const reply = await api.testKey(key, secretInput(key).value)
    let text = TEST_RESULT_TEXT[reply?.status] ?? TEST_RESULT_TEXT.network
    // Model listing can pass while the voice endpoint still refuses the key.
    if (reply?.status === 'ok' && reply.realtime && reply.realtime !== 'ok') {
      text = reply.realtime === 'rejected' ? t("密钥可用于文字模型，但实时语音服务拒绝了它（401）：请确认它属于北京站")
        : reply.realtime === 'forbidden' ? t("密钥可用于文字模型，但这个账号无权使用实时语音模型（403）")
        : t("文字模型可用，实时语音暂时无法连接，请检查网络后重试")
    } else if (reply?.status === 'ok' && reply.realtime === 'ok') text = t("密钥有效，实时语音也可用")
    result.dataset.status = reply?.status === 'ok' && (!reply.realtime || reply.realtime === 'ok') ? 'ok' : 'warn'
    result.textContent = text
  } catch {
    result.dataset.status = 'warn'
    result.textContent = TEST_RESULT_TEXT.network
  } finally {
    button.disabled = false
  }
}

// These labels reflect selected public providers only, never any key material.
function keyUsage(view) {
  return {
    ...Object.fromEntries(COMPATIBLE_STAGES.map(({provider,secret}) => [secret, view[provider] === 'openai-compatible' && (provider === 'cascadedLlmProvider' || view.pipelineMode === 'cascaded') ? t("必需") : t("当前未使用")])),
    dashscopeApiKey: (view.pipelineMode === 'integrated' && view.integratedProvider === 'qwen')
      || (view.pipelineMode === 'cascaded' && view.cascadedLlmProvider === 'qwen') ? t("必需")
      : view.pipelineMode === 'integrated' && view.integratedProvider === 'stepfun'
        ? memoryEmbeddingNote(view.capabilities?.runtime?.modules?.memory, moduleStatusNote) ?? t("仅本地记忆嵌入需要")
        : memoryEmbeddingNote(view.capabilities?.runtime?.modules?.memory, moduleStatusNote) ?? t("可选；不配则联网搜索回退与本地记忆嵌入关闭"),
    stepfunApiKey: view.pipelineMode === 'integrated' && view.integratedProvider === 'stepfun' ? t("必需") : t("当前未使用"),
    openaiApiKey: (view.pipelineMode === 'integrated' ? view.integratedProvider : view.cascadedLlmProvider) === 'openai' ? t('必需') : t('当前未使用'),
    geminiApiKey: (view.pipelineMode === 'integrated' ? view.integratedProvider === 'gemini' : [view.cascadedAsrProvider,view.cascadedLlmProvider,view.cascadedTtsProvider].includes('gemini')) ? t('必需') : t('当前未使用'),
    deepseekApiKey: view.pipelineMode === 'cascaded' && view.cascadedLlmProvider === 'deepseek' ? t("必需") : view.codingBackend === 'deepseek' ? t("编程执行器可使用") : t("当前未使用"),
    arkApiKey: view.pipelineMode === 'cascaded'
      && view.cascadedLlmProvider === 'ark' ? t("必需") : t("当前未使用"),
    doubaoBigmodelApiKey: view.pipelineMode === 'cascaded' && [view.cascadedAsrProvider,view.cascadedTtsProvider].includes('volcengine') ? t("必需") : t("当前未使用"),
    composioApiKey: t('应用连接；修改后需重启'),
    tavilyApiKey: searchKeyUsage(view.capabilities?.runtime?.modules?.search),
    openrouterApiKey: t("增强个性化（可选）；不配则改用对话模型判断资讯相关度，可在“主动性”里关闭"),
  }
}

// Search without a Tavily key reuses the DashScope key through the Bailian preset, or turns off (capability-registry.ts).
function searchKeyUsage(search) {
  const note = moduleStatusNote(search)
  return note || t("可选；不配则回退百炼联网搜索（需 DashScope 密钥），两者都没有则搜索关闭")
}

function renderKeyUsage(view) {
  const usage = keyUsage(view)
  for (const [key, text] of Object.entries(usage)) document.querySelector(`#usage-${key}`).textContent = text
  for (const key of SECRET_KEYS) {
    const endpoint = document.querySelector(`details[data-endpoint="${key}"]`)
    if (endpoint && usage[key] === t("必需")) endpoint.open = true
  }
}

function renderPreset(select, customInput, value, presets) {
  const choice = resolveVoiceChoice(value, presets)
  select.value = choice.selected
  customInput.hidden = choice.selected !== CUSTOM_VOICE_VALUE
  if (choice.selected === CUSTOM_VOICE_VALUE) customInput.value = choice.custom
}

function renderCodingBackend(view) {
  const backendId = Object.hasOwn(CODING_GUIDANCE, view.codingBackend) ? view.codingBackend : 'codex'
  codingProvider.value = backendId
  const acp = backendId !== 'codex'
  codingAcpSettings.hidden = !acp
  codexStatus.hidden = acp
  document.querySelector('#codex-discovery').hidden = acp
  codingPermissionNote.textContent = backendId === 'pi'
    ? t("Pi 不支持逐项审批：询问模式下任务会被拒绝，不会自动改为 YOLO。")
    : acp ? t("审批由所选执行器在任务开始时协商；不支持当前审批模式时任务会被拒绝。") : ''
  if (!acp) return
  const [title, configLabel, guidance] = CODING_GUIDANCE[backendId]
  document.querySelector('#coding-backend-title').textContent = t("{0} 配置", title)
  document.querySelector('#coding-backend-guidance').textContent = t(guidance)
  document.querySelector('#coding-config-field').hidden = !configLabel
  document.querySelector('#coding-config-label').textContent = configLabel ? t(configLabel) : ''
  codingBinaryPath.value = view.codingBackendPaths?.[backendId]?.binaryPath ?? ''
  codingConfigPath.value = view.codingBackendPaths?.[backendId]?.configPath ?? ''
  const status = view.codingBackends?.[backendId]
  document.querySelector('#coding-backend-status').textContent = [
    status?.binary === 'available' ? t("已找到可执行文件") : status?.binary === 'missing' ? t("未找到可执行文件，请安装或指定路径") : t("可执行文件待检测"),
    status?.configuration === 'missing' ? t("配置路径不可用") : codingConfigPath.value ? t("使用指定的配置来源") : t("使用默认配置"),
    t("登录状态尚未验证，会在任务开始时检查。"),
  ].join(t("；"))
}

function renderCodexStatus(view) {
  const status = view.codexStatus
  if (status?.status !== 'ready') {
    codexStatus.textContent = t("未找到可用的 Codex CLI；可刷新或指定完整路径，Windows 支持 npm 安装的 codex.cmd。")
    codexStatus.dataset.ready = '0'
    return
  }
  codexStatus.textContent = t("已连接 {0}", status.version)
  codexStatus.dataset.ready = '1'
}

function updateButtons() {
  const state = settingsButtonState({
    dirty: controllerState.dirty || dirtySecretKeys.size > 0,
    controllerBusy: controllerState.busy,
    lifecycleBusy: currentView?.managedWorkspaces?.lifecycleBusy === true,
    workspaceBusy,
    managedHealth: currentView?.managedWorkspaces?.health,
    managedRecoveryStatus: currentView?.managedWorkspaces?.recoveryStatus,
    currentManagedAvailable: currentView?.managedWorkspaces?.current?.available === true,
    allManagedAvailable: currentView?.managedWorkspaces?.all?.available === true,
  })
  settingsSave.disabled = state.saveDisabled || restarting
  settingsRestart.disabled = controllerState.busy || workspaceBusy || restarting || currentView?.managedWorkspaces?.lifecycleBusy === true
  workspaceOpenCurrent.disabled = state.currentDisabled
  workspaceClearCurrent.disabled = state.currentDisabled
  workspaceClearAll.disabled = state.workspaceDisabled
  document.querySelector('#startup-retry').disabled = controllerState.busy || workspaceBusy || currentView?.managedWorkspaces?.lifecycleBusy === true
  workspaceRetryRecovery.disabled = state.recoveryDisabled
  settingsRestore.disabled = controllerState.busy || workspaceBusy || currentView?.managedWorkspaces?.lifecycleBusy === true
}

let usageScope = 'session'
let usageGroup = 'features'
document.getElementById('usage-group').addEventListener('change',event=>{usageGroup=event.target.value;renderUsage()})
function renderUsage() {
  const usage = currentView?.frontendUsage
  const selected = usageScope === 'history' ? usage?.history : usage
  for (const scope of ['history', 'session']) {
    const value = scope === 'history' ? usage?.history : usage
    const cost = value?.requests && !value?.unavailable ? frontendUsageText(value).split('\n')[0] : '—'
    document.getElementById(`usage-${scope}-cost`).textContent = cost
    document.getElementById(`usage-${scope}-count`).textContent = value?.unavailable ? t("读取失败") : t("{0} 次调用", value?.requests ?? 0)
    document.getElementById(`usage-${scope}`).dataset.empty = String(!value?.requests)
    document.getElementById(`usage-${scope}`).setAttribute('aria-pressed', String(usageScope === scope))
  }
  const notices = []
  if (selected?.missingReports) notices.push(t("缺少用量 {0} 次", selected.missingReports))
  if (selected?.unpricedReports) notices.push(t("无法估价 {0} 次", selected.unpricedReports))
  const status = document.getElementById('frontend-usage')
  status.textContent = usage?.persistenceError
    ? (usage.persistenceError === 'storage_failed' ? t("用量记录保存失败，历史可能不完整。") : usage.persistenceError === 'read_failed' ? t("历史记录读取失败，原文件已保留；当前仅显示本次启动用量。") : t("历史用量保存失败，本次用量仍保留在内存中。"))
    : selected?.requests ? notices.join(' · ') : t("模型调用后显示用量")
  status.hidden = !status.textContent
  const breakdown = document.getElementById('usage-breakdown')
  breakdown.hidden = !selected?.requests
  if (breakdown.hidden) breakdown.open = true
  renderFrontendUsage(document.getElementById('frontend-usage-details'), selected, document,usageGroup)
}
for (const scope of ['history', 'session']) document.getElementById(`usage-${scope}`).addEventListener('click', () => {
  usageScope = scope
  renderUsage()
})

const MODEL_ROUTE_SECRETS = {
  DASHSCOPE_API_KEY: 'dashscopeApiKey', DEEPSEEK_API_KEY: 'deepseekApiKey', OPENAI_API_KEY: 'openaiApiKey',
  GEMINI_API_KEY: 'geminiApiKey', STEPFUN_API_KEY: 'stepfunApiKey', ARK_API_KEY: 'arkApiKey',
  OPENAI_COMPATIBLE_API_KEY: 'openaiCompatibleApiKey', SELF_HOSTED_LLM_API_KEY: 'selfHostedLlmApiKey',
}
const MODEL_ROUTE_LANES = [
  {id: 'conversationText', label: '对话文本', capability: 'text', follow: false},
  {id: 'support', label: '辅助与后台', capability: 'text', follow: true},
  {id: 'fast', label: '记忆提取', capability: 'text', follow: true},
  {id: 'compressor', label: '上下文压缩', capability: 'text', follow: true},
  {id: 'watch', label: '视觉监控', capability: 'vision', follow: false},
  {id: 'embedding', label: '知识与记忆嵌入', capability: 'embedding', follow: false},
]
let modelPane = 'routes'
function applyModelPane(pane) {
  modelPane = pane === 'pipeline' ? 'pipeline' : 'routes'
  const routes = document.querySelector('#model-routes')
  const pipeline = document.querySelector('#pipeline')
  if (routes) routes.hidden = modelPane !== 'routes'
  if (pipeline) pipeline.hidden = modelPane !== 'pipeline'
  for (const tab of document.querySelectorAll('[data-model-pane][role="tab"]')) {
    const selected = tab.dataset.modelPane === modelPane
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
}
for (const tab of document.querySelectorAll('[data-model-pane][role="tab"]')) {
  tab.addEventListener('click', () => applyModelPane(tab.dataset.modelPane))
}
function routeModelChoices(catalog, lane, provider) {
  return (catalog?.models ?? []).filter(model => model.provider === provider && (model.capabilities ?? []).includes(lane.capability))
}
function renderModelRoutes(view) {
  const root = document.querySelector('#model-routes')
  if (!root) return
  root.replaceChildren()
  const catalog = view.modelCatalog
  const secrets = view.secretsPresent ?? {}
  if (!catalog?.providers?.length) {
    const note = document.createElement('p'); note.className = 'hint'; note.textContent = t('模型目录暂时不可用，请重启后台后重试。'); root.append(note); return
  }
  const configured = catalog.providers.filter(provider => secrets[MODEL_ROUTE_SECRETS[provider.keyName]] === true && (provider.capabilities ?? []).includes('text'))
  for (const lane of MODEL_ROUTE_LANES) {
    const row = document.createElement('div'); row.className = 'model-route-row'; row.dataset.lane = lane.id
    const copy = document.createElement('div'); copy.className = 'model-route-copy'
    const title = document.createElement('strong'); title.textContent = t(lane.label)
    const note = document.createElement('small'); note.textContent = lane.follow ? t('默认跟随对话模型') : t('用于该能力的全部调用')
    copy.append(title, note); row.append(copy)
    const controls = document.createElement('div'); controls.className = 'model-route-controls'
    const route = view.modelRoutes?.[lane.id] ?? null
    const currentProvider = route?.provider ?? (lane.id === 'conversationText' ? view.cascadedLlmProvider : '')
    const conversationProviders = new Set(['qwen', 'ark', 'deepseek', 'openai', 'gemini', 'self-hosted', 'openai-compatible'])
    const providerChoices = lane.id === 'embedding'
      ? catalog.providers.filter(provider => (provider.capabilities ?? []).includes('embedding') && secrets[MODEL_ROUTE_SECRETS[provider.keyName]] === true)
      : lane.id === 'watch'
        ? catalog.providers.filter(provider => (provider.capabilities ?? []).includes('vision'))
        : configured.filter(provider => lane.id !== 'conversationText' || conversationProviders.has(provider.id))
    const providerSelect = document.createElement('select'); providerSelect.dataset.laneProvider = lane.id
    providerSelect.setAttribute('aria-label', t('{0}服务商', t(lane.label)))
    if (lane.follow) { const follow = document.createElement('option'); follow.value = ''; follow.textContent = t('跟随对话模型'); providerSelect.append(follow) }
    for (const provider of providerChoices) {
      if (lane.id === 'watch' && secrets[MODEL_ROUTE_SECRETS[provider.keyName]] !== true) continue
      const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.label
      if (currentProvider && provider.id !== currentProvider && !providerChoices.some(item => item.id === currentProvider)) option.disabled = false
      providerSelect.append(option)
    }
    if (currentProvider && ![...providerSelect.options].some(option => option.value === currentProvider)) {
      const option = document.createElement('option'); option.value = currentProvider; option.textContent = t('{0}（当前不可用）', currentProvider); option.disabled = true; providerSelect.append(option)
    }
    providerSelect.value = currentProvider || ''
    const modelSelect = document.createElement('select'); modelSelect.dataset.laneModel = lane.id
    modelSelect.setAttribute('aria-label', t('{0}模型', t(lane.label)))
    const selectedProvider = providerSelect.value
    const currentModel = route?.model ?? (lane.id === 'conversationText' ? view.cascadedLlmModels?.[view.cascadedLlmProvider] : '')
    const choices = routeModelChoices(catalog, lane, selectedProvider)
    for (const model of choices) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.label; modelSelect.append(option) }
    if (currentModel && ![...modelSelect.options].some(option => option.value === currentModel)) { const option = document.createElement('option'); option.value = currentModel; option.textContent = t('{0}（当前不可用）', currentModel); modelSelect.append(option) }
    modelSelect.value = currentModel || choices[0]?.id || ''
    modelSelect.disabled = !selectedProvider
    const customModel = document.createElement('input'); customModel.type = 'text'; customModel.maxLength = 256
    customModel.dataset.laneCustomModel = lane.id; customModel.placeholder = t('输入模型 ID'); customModel.value = choices.length ? '' : (route?.model ?? '')
    customModel.hidden = choices.length > 0; customModel.setAttribute('aria-label', t('{0}自定义模型 ID', t(lane.label)))
    const stageRoute = model => {
      const provider = providerSelect.value
      if (!provider || !model) return
      controller.stage({modelRoutes: {[lane.id]: {provider, model}}, ...(lane.id === 'conversationText' ? {cascadedLlmProvider: provider, cascadedLlmModels: {[provider]: model}} : {})})
    }
    providerSelect.addEventListener('change', () => {
      const provider = providerSelect.value
      if (lane.follow && provider === '') { controller.stage({modelRoutes: {[lane.id]: null}}); return }
      const next = routeModelChoices(catalog, lane, provider)
      const model = next[0]?.id ?? ''
      customModel.hidden = next.length > 0
      modelSelect.hidden = next.length === 0
      if (!provider) return
      if (model) stageRoute(model)
      else if (customModel.value.trim()) stageRoute(customModel.value.trim())
    })
    modelSelect.addEventListener('change', () => { if (modelSelect.value) stageRoute(modelSelect.value) })
    customModel.addEventListener('change', () => { if (customModel.value.trim()) stageRoute(customModel.value.trim()) })
    controls.append(providerSelect, modelSelect, customModel)
    if (currentProvider && !secrets[MODEL_ROUTE_SECRETS[catalog.providers.find(item => item.id === currentProvider)?.keyName]] && providerChoices.length === 0) controls.append(Object.assign(document.createElement('span'), {className: 'hint', textContent: t('请先在 API 密钥中配置服务商密钥')}))
    row.append(controls); root.append(row)
  }
  const account = document.createElement('p'); account.className = 'hint'
  account.textContent = t('编程执行器与 ChatGPT 账号分别在「执行器 → 编程」「API 密钥」中配置。')
  root.append(account)
}

function render(view, drafts, state) {
  if (!view) return
  document.getElementById('startup-view').value = view.startupView ?? 'workbench'
  document.getElementById('language').value = view.language ?? 'zh-CN'
  document.getElementById('language-restart-hint').hidden = (view.language ?? 'zh-CN') === currentLanguage()
  currentView = view
  const skillList=Array.isArray(view.skills)?view.skills:null
  if(JSON.stringify(skillList)!==JSON.stringify(skillsState.skills)){skillsState.skills=skillList;if(activeCategory==='skills')renderSettingsSkills()}
  skinPanel.render(view, state)
  renderUsage()
  renderModelRoutes(view)
  capabilityEditor.render(view)
  knowledgePanel.render(view)
  memoryPrerecall.checked = view.memoryPrerecallEnabled === true
  for (const input of capabilitySettings) input.value = view[input.id] ?? ''
  controllerState = state
  wakeEnabled.checked = view.wakeWordEnabled === true
  autoHideSeconds.value = String(view.autoHideSeconds ?? 60)
  wakeStatus.hidden = !['loading', 'error'].includes(view.wakeWord?.status)
  wakeStatus.textContent = ({off: '', loading: t("正在准备唤醒模型…"), ready: t("本地唤醒已就绪"), error: t("唤醒模型不可用，请重试；可用托盘显示窗口。")})[view.wakeWord?.status] ?? ''
  wakeRetry.hidden = view.wakeWord?.status !== 'error'

  codingProgressNarrationInput.value = view.codingProgressNarration
  for (const input of proactivityInputs) input.checked = input.value === view.proactivity
  proactivityPanel.setMemory(view.capabilities?.runtime?.modules?.memory)
  for (const input of pipelineModeInputs) input.checked = input.value === view.pipelineMode
  for (const input of codexApprovalModeInputs) {
    input.checked = input.value === view.codexApprovalMode
  }
  generatePlanInput.checked = view.generatePlan !== false
  buildReasoningInput.checked = view.buildReasoning === true
  profileParticipantMessagesInput.checked = view.profileParticipantMessages === true
  for (const input of planReadbackInputs) input.checked = input.value === view.planReadback
  for (const input of progressBubblesInputs) input.checked = input.value === view.progressBubbles
  yoloWarning.hidden = view.codexApprovalMode !== 'yolo'
  clarificationDepth.value = view.clarificationDepth
  heartbeat.value = String(view.codexHeartbeatSeconds)
  heartbeatValue.textContent = t("{0} 秒", view.codexHeartbeatSeconds)
  for (const input of codexModeInputs) input.checked = input.value === view.codexBinaryMode
  renderCodingBackend(view)
  const codexVisibility = codexModeVisibility(view.codexBinaryMode)
  codexManualSettings.hidden = codexVisibility.manualConfigurationHidden
  codexRescan.hidden = codexVisibility.rescanHidden
  codexBinaryPath.disabled = view.codexBinaryMode !== 'manual'
  codexBinaryPath.value = view.codexBinaryPath ?? ''
  codexWorkspace.value = view.codexWorkspace ?? ''
  codexManagedRoot.value = view.codexManagedRoot ?? ''
  effectiveWorkspace.textContent = view.effectivePaths?.workspace ?? ''
  effectiveManagedRoot.textContent = view.effectivePaths?.managedRoot ?? ''
  if (dataRootNotice) dataRootNotice.textContent = view.dataRootNotice ? (view.dataRootNotice.kind === 'link' ? t('数据已迁移，但兼容链接 {0} 缺失或指向别处。请先退出 Nova，再运行 {1} 修复。', view.dataRootNotice.path, view.dataRootNotice.command) : t('本地数据仍在 {0}。如需迁移到新目录，请先退出 Nova，再运行 {1}（可选）。', view.dataRootNotice.path, view.dataRootNotice.command)) : ''
  renderCodexStatus(view)
  integratedSection.hidden = view.pipelineMode !== 'integrated'
  cascadedSection.hidden = view.pipelineMode !== 'cascaded'
  document.getElementById('gemini-live-limit').hidden = view.integratedProvider !== 'gemini'
  integratedProvider.value = view.integratedProvider
  for(const [provider,profile] of Object.entries(NATIVE_VOICE_PROVIDERS)) {
    document.getElementById('native-'+provider).hidden=view.integratedProvider!==provider
    const input=document.getElementById(profile.endpoint)
    if(document.activeElement!==input)input.value=view[profile.endpoint]??profile.defaultUrl
  }
  integratedVoicePreset.closest('.field').hidden=view.integratedProvider==='minicpm-o'
  const integratedModels = NATIVE_VOICE_PROVIDERS[view.integratedProvider] ? [{value:view.integratedProvider,label:view.integratedProvider==='minicpm-o'?'MiniCPM-o 4.5':'PersonaPlex 7B'}] : view.integratedProvider === 'openai' ? ['gpt-realtime-2.1-mini','gpt-realtime-2.1'].map(value=>({value,label:value}))
    : view.integratedProvider === 'gemini' ? [{value:'gemini-3.8-live',label:'Gemini 3.8 Live'}]
    : view.integratedProvider === 'stepfun'
    ? [{value: 'stepaudio-3-realtime-preview', label: 'StepAudio 3 Realtime Preview'}]
    : [{value: 'qwen-audio-3.1-realtime-plus', label: 'Qwen Audio 3.1 Plus'},
      {value: 'qwen-audio-3.0-realtime-plus', label: 'Qwen Audio 3.0 Plus'},
      {value: 'qwen-audio-3.0-realtime-flash', label: 'Qwen Audio 3.0 Flash'},
      {value: 'qwen3.5-omni-flash-realtime', label: 'Qwen3.5 Omni Flash Realtime'},
      {value: 'qwen3.5-omni-plus-realtime', label: 'Qwen3.5 Omni Plus Realtime'}]
  integratedModel.replaceChildren(...integratedModels.map(preset => {
    const option = document.createElement('option'); option.value = preset.value; option.textContent = preset.label; return option
  }))
  if (view.integratedModel && ![...integratedModel.children].some(option => option.value === view.integratedModel)) {
    const option = document.createElement('option'); option.value = view.integratedModel; option.textContent = view.integratedModel; integratedModel.append(option)
  }
  integratedModel.value = view.integratedModel ?? ''
  const voices = NATIVE_VOICE_PROVIDERS[view.integratedProvider] ? (nativeVoices.get(view.personaplexRealtimeUrl)??['NATF2']).map(value=>({value,label:value})) : view.integratedProvider === 'openai' ? ['marin','cedar','alloy','coral'].map(value=>({value,label:value}))
    : view.integratedProvider === 'gemini' ? ['Kore','Puck','Aoede','Charon','Fenrir'].map(value=>({value,label:value}))
    : view.integratedProvider === 'stepfun' ? STEPFUN_VOICES
    : view.integratedModel?.startsWith('qwen3.5-omni-') ? [{value: 'Ethan', label: t("Ethan（默认）")}] : view.integratedModel === 'qwen-audio-3.1-realtime-plus' ? QWEN_31_VOICES : QWEN_VOICES
  populatePresetOptions(integratedVoicePreset, voices)
  renderPreset(integratedVoicePreset, integratedVoiceCustom, view.integratedVoice, voices)
  voiceprintPanel.render(view, drafts)
  for (const {stage, provider, endpoint} of SELF_HOSTED_STAGES) {
    document.querySelector(`#self-hosted-${stage}-settings`).hidden = view[provider] !== 'self-hosted'
    const input = document.querySelector(`#${endpoint}`)
    if (document.activeElement !== input) input.value = view[endpoint] ?? ''
  }
  for (const {stage, provider} of COMPATIBLE_STAGES) {
    document.querySelector(`#compatible-${stage}-settings`).hidden = view[provider] !== 'openai-compatible'
  }
  for (const key of COMPATIBLE_FIELDS) {
    const input = document.querySelector(`#${key}`)
    if (['compatibleAsrOmitResponseFormat','compatibleTtsSendSampleRate'].includes(key)) input.checked = view[key] === true
    else if (document.activeElement !== input) input.value = view[key] ?? ''
  }
  cascadedLlmModel.maxLength = view.cascadedLlmProvider === 'openai-compatible' ? 256 : 64
  cascadedAsrProvider.value = view.cascadedAsrProvider
  geminiAsrModel.value = view.geminiAsrModel
  geminiTtsModel.value = view.geminiTtsModel
  document.querySelector('#gemini-asr-settings').hidden = view.cascadedAsrProvider !== 'gemini'
  document.querySelector('#gemini-tts-settings').hidden = view.cascadedTtsProvider !== 'gemini'
  cascadedLlmProvider.value = view.cascadedLlmProvider
  const modelPresets = ({
    qwen: [
      {value: 'qwen3.8-flash', label: t("qwen3.8-flash · 第一档 · ★★★★★")},
      {value: 'qwen-flash', label: t("qwen-flash · 第二档 · ★★★★☆")},
      {value: 'qwen3.8-max', label: t("qwen3.8-max · 第二档 · ★★★★☆")},
      {value: 'qwen-plus', label: t("qwen-plus · 第三档 · ★★★☆☆")},
    ],
    openai: [{value:'gpt-6-luna',label:'GPT-6 Luna'}],
    gemini: ['gemini-3.5-flash-lite','gemini-3.8-flash'].map(value=>({value,label:value})),
    deepseek: [{value: 'deepseek-flash', label: t("deepseek-flash · 第一档 · ★★★★★")}],
    ark: [{value: 'doubao-seed-2-0-pro-260215', label: 'doubao-seed-2-0-pro-260215'}],
  }[view.cascadedLlmProvider] ?? [])
  populatePresetOptions(cascadedLlmModelPreset, modelPresets, t("自定义模型 ID…"))
  renderPreset(cascadedLlmModelPreset, cascadedLlmModel, view.cascadedLlmModels?.[view.cascadedLlmProvider], modelPresets)
  document.querySelector('#cascaded-tts-voice-settings').hidden = ['self-hosted','openai-compatible'].includes(view.cascadedTtsProvider)
  cascadedTtsProvider.value = view.cascadedTtsProvider
  const ttsVoices = view.cascadedTtsProvider === 'gemini' ? GEMINI_TTS_VOICES : VOLCENGINE_TTS_VOICES
  populatePresetOptions(cascadedTtsVoicePreset, ttsVoices)
  renderPreset(cascadedTtsVoicePreset, cascadedTtsVoiceCustom, view.cascadedTtsProvider === 'gemini' ? view.geminiTtsVoice : view.cascadedTtsVoice, ttsVoices)
  renderBadges(view.secretsPresent, view.secretSources)
  renderKeyUsage(view)
  document.querySelector('#startup-status').dataset.stage = view.startup?.stage ?? ''
  startupNotice.update(view.startup)
  document.querySelector('#startup-retry').hidden = view.startup?.stage !== 'failed'
  warning.hidden = view.keyringAvailable !== false
  const recoveryStatus = view.managedWorkspaces?.recoveryStatus ?? 'idle'
  const recoveryRequired = recoveryStatus !== 'idle'
  workspaceRetryRecovery.hidden = !recoveryRequired
  if (recoveryRequired && !workspaceBusy) {
    workspaceActionStatus.textContent = recoveryStatus === 'failed'
      ? WORKSPACE_STATUS_TEXT.recovery_failed
      : WORKSPACE_STATUS_TEXT.rollback_pending
  }
  settingsRestore.hidden = view.settingsRecoveryAvailable !== true
  if (view.settingsApplyStatus === 'recovery_pending' || view.settingsApplyStatus === 'recovery_failed') {
    updateRestartNotice(view.settingsApplyStatus)
  } else if (view.settingsApplyStatus === 'applied' && view.settingsRecoveryAvailable === false
    && (restartNotice.dataset.state === 'recovery_pending' || restartNotice.dataset.state === 'recovery_failed')) {
    updateRestartNotice('complete')
  }
  updateButtons()
}

function updateRestartNotice(phase) {
  restartNotice.hidden = false
  restartNotice.dataset.state = phase
  if (phase === 'restarting') {
    restartNotice.textContent = t("已保存，后台正在重启并重新连接")
    return
  }
  if (phase === 'failed') {
    restartNotice.textContent = t("未生效：请恢复上次可用设置，再检查未保存的草稿")
    return
  }
  if (phase === 'restart_failed') {
    restartNotice.textContent = t("后端未启动：上次设置已保留，请恢复后端")
    return
  }
  if (phase === 'recovery_pending') {
    restartNotice.textContent = t("上次设置已还原，请点击恢复以确认后端可用")
    return
  }
  if (phase === 'recovery_failed') {
    restartNotice.textContent = t("设置恢复未完成，恢复记录已保留；若重试仍失败，请修复配置目录中的 settings.json.recovery 或配置冲突后再恢复")
    return
  }
  restartNotice.textContent = t("设置已生效")
}

const controller = createSettingsController({
  api: {...api, set: patch => {
    const {capabilitiesDocument, capabilitiesBaseRevision, ...settingsPatch} = patch
    return api.set({settingsPatch, ...(capabilitiesDocument === undefined ? {} : {capabilitiesDocument, capabilitiesBaseRevision})})
  }}, render,
  status: note => { statusLabel.textContent = note },
  notice: updateRestartNotice,
})
api.onChanged(view => {
  if (isValidCategory(view?.focusCategory)) applyCategory(view.focusCategory)
  controller.syncView(view)
})

function bindStage(element, event, patch) {
  element.addEventListener(event, () => { controller.stage(patch()) })
}


bindStage(document.getElementById('language'), 'change', () => ({language: document.getElementById('language').value}))
bindStage(wakeEnabled, 'change', () => ({wakeWordEnabled: wakeEnabled.checked}))
bindStage(autoHideSeconds, 'change', () => {
  const value = Number(autoHideSeconds.value)
  const valid = Number.isInteger(value) && (value === 0 || value >= 30 && value <= 3600)
  autoHideSeconds.setCustomValidity(valid ? '' : t("请输入 0 或 30–3600 的整数"))
  autoHideSeconds.reportValidity()
  return valid ? {autoHideSeconds: value} : {}
})
onButton(wakeRetry, () => window.novaPersonalAgentDesktop.wakeWord.retry(), () => {statusLabel.textContent=t('操作未完成')})
for (const event of ['pointerdown', 'keydown']) {
  document.addEventListener(event, () => window.novaPersonalAgentDesktop.wakeWord.activity())
}
bindStage(codingProgressNarrationInput, 'change', () => ({codingProgressNarration: codingProgressNarrationInput.value}))
for (const input of proactivityInputs) bindStage(input, 'change', () => ({proactivity: input.value}))
for (const input of pipelineModeInputs) bindStage(input, 'change', () => ({pipelineMode: input.value}))
bindStage(codingProvider, 'change', () => ({codingBackend: codingProvider.value}))
bindStage(codingBinaryPath, 'input', () => ({codingBackendPaths: {[codingProvider.value]: {binaryPath: codingBinaryPath.value}}}))
bindStage(codingConfigPath, 'input', () => ({codingBackendPaths: {[codingProvider.value]: {configPath: codingConfigPath.value}}}))
for (const input of codexApprovalModeInputs) {
  bindStage(input, 'change', () => ({codexApprovalMode: input.value}))
}
bindStage(generatePlanInput, 'change', () => ({generatePlan: generatePlanInput.checked}))
bindStage(buildReasoningInput, 'change', () => ({buildReasoning: buildReasoningInput.checked}))
bindStage(profileParticipantMessagesInput, 'change', () => ({profileParticipantMessages: profileParticipantMessagesInput.checked}))
for (const input of planReadbackInputs) bindStage(input, 'change', () => ({planReadback: input.value}))
for (const input of progressBubblesInputs) {
  bindStage(input, 'change', () => ({progressBubbles: input.value}))
}
bindStage(clarificationDepth, 'change', () => ({clarificationDepth: clarificationDepth.value}))
bindStage(memoryPrerecall, 'change', () => ({memoryPrerecallEnabled: memoryPrerecall.checked}))
for (const input of capabilitySettings) bindStage(input, 'change', () => ({[input.id]: input.value}))
heartbeat.addEventListener('input', () => {
  heartbeatValue.textContent = t("{0} 秒", heartbeat.value)
  controller.stage({codexHeartbeatSeconds: Number(heartbeat.value)})
})
for (const input of codexModeInputs) bindStage(input, 'change', () => ({codexBinaryMode: input.value}))
bindStage(codexBinaryPath, 'input', () => ({codexBinaryPath: codexBinaryPath.value}))
bindStage(codexWorkspace, 'input', () => ({codexWorkspace: codexWorkspace.value}))
bindStage(codexManagedRoot, 'input', () => ({codexManagedRoot: codexManagedRoot.value}))
bindStage(integratedProvider, 'change', () => ({
  integratedProvider: integratedProvider.value,
  integratedModel: NATIVE_VOICE_PROVIDERS[integratedProvider.value]?.model ?? (integratedProvider.value === 'openai' ? 'gpt-realtime-2.1-mini' : integratedProvider.value === 'gemini' ? 'gemini-3.8-live' : integratedProvider.value === 'stepfun' ? 'stepaudio-3-realtime-preview' : 'qwen-audio-3.0-realtime-plus'),
  integratedVoice: NATIVE_VOICE_PROVIDERS[integratedProvider.value]?.voice ?? (integratedProvider.value === 'openai' ? 'marin' : integratedProvider.value === 'gemini' ? 'Kore' : integratedProvider.value === 'stepfun' ? 'default' : 'longanqian'),
}))
bindStage(integratedModel, 'change', () => ({
  integratedModel: integratedModel.value,
  ...(!NATIVE_VOICE_PROVIDERS[integratedProvider.value] && integratedModel.value !== currentView?.integratedModel
    ? {integratedVoice: integratedProvider.value === 'openai' ? 'marin' : integratedProvider.value === 'gemini' ? 'Kore' : integratedProvider.value === 'stepfun' ? 'default' : integratedModel.value.startsWith('qwen3.5-omni-') ? 'Ethan' : integratedModel.value === 'qwen-audio-3.1-realtime-plus' ? 'longanqian_v3.1' : 'longanqian'} : {}),
}))
bindStage(geminiAsrModel, 'input', () => ({geminiAsrModel: geminiAsrModel.value}))
bindStage(geminiTtsModel, 'input', () => ({geminiTtsModel: geminiTtsModel.value}))
function stageCompatiblePatch(patch) {
  for (const {endpoint, secret} of COMPATIBLE_STAGES) {
    if (Object.hasOwn(patch, endpoint) && currentView?.[endpoint] !== patch[endpoint]) {
      secretInput(secret).value = ''
      dirtySecretKeys.add(secret)
      secretRevisions.noteInput(secret)
    }
  }
  controller.stage(patch)
}
for (const {stage, endpoint, model} of COMPATIBLE_STAGES) {
  const preset = document.querySelector(`#compatible-${stage}-preset`)
  for (const item of COMPATIBLE_PRESETS[stage]) {
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; preset.append(option)
  }
  preset.addEventListener('change', () => {
    const item = COMPATIBLE_PRESETS[stage].find(item => item.id === preset.value)
    if (!item) return
    const patch = {[endpoint]: item.baseUrl}
    if (model) patch[model] = item.model
    if (stage === 'llm') { patch.openaiCompatibleProtocol = item.protocol; patch.cascadedLlmModels = {'openai-compatible': ''} }
    if (stage === 'asr') patch.compatibleAsrOmitResponseFormat = item.omitResponseFormat === true
    if (stage === 'tts') { patch.compatibleTtsVoice = item.voice; patch.compatibleTtsSendSampleRate = item.sendSampleRate }
    stageCompatiblePatch(patch)
  })
}
for (const key of COMPATIBLE_FIELDS) {
  const input = document.querySelector(`#${key}`)
  input.addEventListener('change', () => {
    for (const {stage} of COMPATIBLE_STAGES) document.querySelector(`#compatible-${stage}-preset`).value = ''
    stageCompatiblePatch({[key]: ['compatibleAsrOmitResponseFormat','compatibleTtsSendSampleRate'].includes(key) ? input.checked : input.value})
  })
}
function stageSelfHostedPatch(patch) {
  for (const {endpoint, secret} of SELF_HOSTED_STAGES) {
    if (Object.hasOwn(patch, endpoint) && endpointOrigin(currentView?.[endpoint]) !== endpointOrigin(patch[endpoint])) {
      secretInput(secret).value = ''
      dirtySecretKeys.add(secret)
      secretRevisions.noteInput(secret)
    }
  }
  controller.stage(patch)
}
for (const {endpoint} of SELF_HOSTED_STAGES) {
  const input = document.querySelector(`#${endpoint}`)
  input.addEventListener('change', () => stageSelfHostedPatch({[endpoint]: input.value}))
}
for (const action of ['import', 'export']) {
  document.querySelector(`#voice-preset-${action}`).addEventListener('click', async () => {
    const status = document.querySelector('#voice-preset-status')
    try {
      const result = await api.voicePreset(action, action === 'export' ? controller.snapshot().view : undefined)
      if (result.canceled) return
      if (result.error) throw new Error(result.error)
      if (result.patch) stageSelfHostedPatch(result.patch)
      // Name where audio and context will go before the user commits to Save.
      const hosts = [...new Set(SELF_HOSTED_STAGES.filter(({endpoint}) => result.patch?.[endpoint]).map(({endpoint}) => new URL(result.patch[endpoint]).host))]
      status.textContent = t(action === 'import' ? '预设已导入，请保存。' : '语音预设已导出（不含密钥）。') + (hosts.length ? ` → ${hosts.join(', ')}` : '')
    } catch { status.textContent = t('预设操作失败：请检查 JSON 版本、地址和模型；至少选择一个支持的完整阶段。') }
  })
}
bindStage(cascadedAsrProvider, 'change', () => ({cascadedAsrProvider: cascadedAsrProvider.value}))
bindStage(cascadedLlmProvider, 'change', () => ({cascadedLlmProvider: cascadedLlmProvider.value}))
cascadedLlmModelPreset.addEventListener('change', () => {
  const custom = cascadedLlmModelPreset.value === CUSTOM_VOICE_VALUE
  cascadedLlmModel.hidden = !custom
  if (custom) { cascadedLlmModel.focus(); return }
  controller.stage({cascadedLlmModels: { [cascadedLlmProvider.value]: cascadedLlmModelPreset.value }})
})
cascadedLlmModel.addEventListener('input', () => {
  const provider = cascadedLlmProvider.value
  const value = cascadedLlmModel.value
  controller.stage({cascadedLlmModels: { [provider]: value }})
})
bindStage(cascadedTtsProvider, 'change', () => ({cascadedTtsProvider: cascadedTtsProvider.value}))

function bindVoicePicker(field, select, customInput) {
  select.addEventListener('change', () => {
    const custom = select.value === CUSTOM_VOICE_VALUE
    customInput.hidden = !custom
    if (custom) {
      customInput.focus()
      return
    }
    controller.stage({[typeof field === 'function' ? field() : field]: select.value})
  })
  customInput.addEventListener('input', () => { controller.stage({[typeof field === 'function' ? field() : field]: customInput.value}) })
}

for(const [provider,profile] of Object.entries(NATIVE_VOICE_PROVIDERS)) {
  document.getElementById(profile.endpoint).addEventListener('input',event=>controller.stage({[profile.endpoint]:event.target.value}))
  document.getElementById('probe-'+provider).addEventListener('click',async()=>{
    const label=document.getElementById('probe-status-'+provider),button=document.getElementById('probe-'+provider)
    button.disabled=true;label.textContent=t('正在检查服务…')
    try {const result=await api.nativeVoiceCapabilities(provider);if(provider==='personaplex')nativeVoices.set(result.endpoint,result.voices);label.textContent=t('服务已就绪');if(provider===currentView.integratedProvider&&result.endpoint===currentView[profile.endpoint]){const voices=result.voices.map(value=>({value,label:value}));populatePresetOptions(integratedVoicePreset,voices);renderPreset(integratedVoicePreset,integratedVoiceCustom,currentView.integratedVoice,voices)}}
    catch {label.textContent=t('无法确认服务能力，请先保存设置，并检查服务地址、连接和密钥。')}
    finally {button.disabled=false}
  })
}
bindVoicePicker('integratedVoice', integratedVoicePreset, integratedVoiceCustom)
bindVoicePicker(() => cascadedTtsProvider.value === 'gemini' ? 'geminiTtsVoice' : 'cascadedTtsVoice', cascadedTtsVoicePreset, cascadedTtsVoiceCustom)

for (const key of SECRET_KEYS) {
  secretInput(key).addEventListener('input', () => {
    secretRevisions.noteInput(key)
    dirtySecretKeys.add(key)
    const stale = testResultNode(key)
    if (stale) { stale.textContent = ''; stale.dataset.status = '' }
    renderBadges(currentView?.secretsPresent, currentView?.secretSources)
    updateButtons()
  })
}
for (const button of document.querySelectorAll('button.test')) button.addEventListener('click', () => { void testSecret(button.dataset.key) })
for (const key of SECRET_KEYS) {
  secretClearButton(key).addEventListener('click', () => {
    const input = secretInput(key)
    input.value = ''
    input.hidden = false
    input.focus()
    secretRevisions.noteInput(key)
    dirtySecretKeys.add(key)
    renderBadges(currentView?.secretsPresent, currentView?.secretSources)
    updateButtons()
  })
}

function stagedSecrets() {
  return Object.fromEntries([...dirtySecretKeys].map(key => [key, secretInput(key).value]))
}

async function saveAll() {
  const submissions = Object.fromEntries([...dirtySecretKeys].map(key => {
    const input = secretInput(key)
    return [key, secretRevisions.capture(key, input.value)]
  }))
  const result = await controller.save(stagedSecrets())
  for (const key of result.acceptedSecrets ?? []) {
    const input = secretInput(key)
    if (secretRevisions.matches(key, input.value, submissions[key])) {
      input.value = ''
      dirtySecretKeys.delete(key)
    }
  }
  renderBadges(currentView?.secretsPresent, currentView?.secretSources)
  if (result.rejectedSecrets && result.rejectedSecrets.length) {
    const labels = result.rejectedSecrets.map(key => SECRET_LABELS[key])
    statusLabel.textContent = t("部分密钥未保存(含非法字符): {0}", labels.join('、'))
  }
  updateButtons()
  return result
}

onButton(settingsSave, saveAll, () => {statusLabel.textContent=t('保存失败，请重试')})
onButton(settingsRestart, async () => {
  if (restarting) return
  restarting = true
  updateButtons()
  statusLabel.textContent = t("正在重启后台…")
  try {
    const view = await api.restart()
    controller.syncView(view, {trackRestart: false})
    statusLabel.textContent = view.operationStatus === 'applied' ? t("后台已重启") : view.operationStatus === 'busy' ? t("另一项操作进行中，请稍后重试") : t("重启失败，请检查配置")
  } catch { statusLabel.textContent = t("重启失败，请稍后重试") }
  finally { restarting = false; updateButtons() }
})

onButton(codexRescan, async () => {
  codexRescan.disabled = true
  codexRescan.setAttribute('aria-busy', 'true')
  statusLabel.textContent = t("正在刷新 Codex…")
  try {
    const view = await api.rescanCodex()
    controller.syncView(view, {trackRestart: false})
    statusLabel.textContent = view.operationStatus === 'recovery_pending'
      ? t("Codex 未刷新：请先恢复上次可用设置")
      : view.operationStatus === 'busy' ? t("另一项操作进行中，Codex 未刷新")
      : view.operationStatus == null ? t("Codex 刷新完成") : t("Codex 刷新未完成")
  } catch {
    statusLabel.textContent = t("Codex 刷新失败")
  } finally {
    codexRescan.disabled = false
    codexRescan.setAttribute('aria-busy', 'false')
  }
})
onButton(document.querySelector('#projects-repair'), async () => {
  statusLabel.textContent = t("正在修复 Projects 目录权限…")
  try {
    const results = await Promise.all(['state', 'managed', 'workspace'].map(root => api.repairProjects(root)))
    statusLabel.textContent = results.every(result => result?.status === 'ok')
      ? t("Projects 目录权限已修复")
      : t("部分 Projects 目录无法修复，请检查路径是否存在")
  } catch {
    statusLabel.textContent = t("Projects 目录权限修复失败")
  }
})

async function runWorkspaceAction(action) {
  workspaceBusy = true
  workspaceActionStatus.textContent = t("正在处理…")
  updateButtons()
  try {
    const result = await action()
    workspaceActionStatus.textContent = WORKSPACE_STATUS_TEXT[result?.status] ?? t("操作未完成")
    if (result?.view) controller.syncView(result.view, {trackRestart: false})
  } catch {
    workspaceActionStatus.textContent = t("操作未完成")
  } finally {
    workspaceBusy = false
    updateButtons()
  }
}

onButton(settingsRestore, async () => {
  workspaceBusy = true
  updateButtons()
  try {
    const view = await api.retryBackend()
    controller.syncView(view, {trackRestart: false})
    statusLabel.textContent = view.settingsRecoveryAvailable === false && view.settingsApplyStatus === 'applied'
      ? t("上次设置已恢复并生效；草稿尚未保存") : t("恢复未完成，请重试")
  } catch { statusLabel.textContent = t("恢复未完成，请重试") }
  finally { workspaceBusy = false; updateButtons() }
})

onButton(workspaceOpenCurrent, () => {
  return runWorkspaceAction(() => api.openCurrentManagedWorkspace())
})
onButton(workspaceClearCurrent, () => {
  return runWorkspaceAction(() => api.clearCurrentManagedWorkspace())
})
onButton(workspaceClearAll, () => {
  return runWorkspaceAction(() => api.clearAllManagedWorkspaces())
})
onButton(document.querySelector('#startup-retry'), async () => {
  workspaceBusy = true
  updateButtons()
  try {
    const view = await api.retryBackend()
    controller.syncView(view, {trackRestart: false})
    statusLabel.textContent = view.backendStatus === 'connected' ? t("后台已连接") : startupMessage(view.startup) || t("操作未完成")
  } catch { statusLabel.textContent = t("操作未完成") }
  finally { workspaceBusy = false; updateButtons() }
})

onButton(workspaceRetryRecovery, () => {
  return runWorkspaceAction(async () => {
    const view = await api.retryBackend()
    return {
      status: view?.managedWorkspaces?.recoveryStatus === 'idle'
        ? 'recovered'
        : 'recovery_failed',
      view,
    }
  })
})

// Inside a dedicated category a collapsed disclosure is only a second click,
// so both open on load. Set as a DOM property, never as a markup attribute:
// the panel contract requires these sections ship closed in the source.
for (const id of ['#secrets', '#codex-projects']) {
  const disclosure = document.querySelector(id)
  if (disclosure) disclosure.open = true
}
applyCategory(activeCategory)

void (async () => {
  try {
    const initial = await api.get()
    // A cold open carries its category here rather than on a push, which
    // would have been sent before this module subscribed.
    if (isValidCategory(initial?.focusCategory)) applyCategory(initial.focusCategory)
    controller.setView(initial)
  } catch {
    statusLabel.textContent = t("读取设置失败")
  }
})()

bindStage(document.getElementById('startup-view'), 'change', () => ({startupView: document.getElementById('startup-view').value}))
