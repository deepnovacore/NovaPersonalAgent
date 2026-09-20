# Features

**English** | [简体中文](features.zh-CN.md)

Nova is a desktop voice assistant. Ask it to work on code, report progress, find information, or continue the conversation from your iPhone.

## Conversation and tasks

| Capability | What you can do |
|---|---|
| Realtime voice | Speak naturally and interrupt Nova's reply |
| Coding | Describe a goal, answer necessary questions, and let Codex execute |
| Projects and sessions | Create or switch projects and continue earlier work |
| Progress | Follow task banners, notification bubbles and conversation records |
| Permissions | Accept or decline an operation that requires approval |

Creating or switching projects requires confirmation. Recognition failure is not approval, rejection or cancellation. Disconnecting your phone does not cancel a coding task.

## Information and memory

- **Search** uses your configured search service.
- **Personal memory** recalls facts across conversations; desktop inspection supports local mem0.
- **Document knowledge** searches imported files separately from personal memory.
- **External tools** connect through MCP, exposing only selected tools.

## Voice, vision and phone

Qwen realtime speech is the default. Cascaded mode lets you configure recognition, a language model and speech synthesis separately.

Conversation vision is off by default and requires a supported cascaded model. Independent monitoring watches a selected camera for your requested condition. Both need camera permission and an available device.

Local wake-word detection is optional. It can wake the idle orb, but cannot override explicit mute.

iPhone starts in realtime mode. Hosts supporting cascaded editable input also offer text chat and dictation drafts. The phone message list is not guaranteed to survive an app restart.

## Limits

Coding needs a working, signed-in Codex installation. Model and search services need credentials. Local memory and document knowledge can still send text to remote models.

Memory inspection has no edit or delete buttons. Phone use needs the computer online; phone cameras and background wake words are not supported. Desktop targets macOS and Windows; Linux supports source use.

[Get started](getting-started.md) · [Personal memory](personal-memory.md) · [Connect iPhone](iphone.md)
