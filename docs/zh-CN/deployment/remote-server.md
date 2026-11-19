# Space Host 与 relay

当前开发分支按 Space 固定 Host 角色。Agent runtime 与用户 context 留在自己的电脑上，relay 仅做端到端加密中转，不运行 Agent。手机创建独立 Space，或作为 Client 绑定 Host；Host 离线时不能聊天，也不会自动由手机接管。

设置 Host、注册 Space、启动桌面与手机扫码步骤见 [Space 使用指南](../../zh-CN/space-host-client.md)。自托管 relay 的配置、TLS 与 Docker 说明见 [relay 文档](../../../relay/README.md)。无头 relay 与 Agent Host 是不同组件，不能将运行时部署到托管 relay 上。

旧手机语音服务与 Hub 的双连接产品流程不再用于新 Space。历史发布包不包含新 Space 协议，部署新流程需要构建当前分支。每个 Space 的角色在创建时确定；更换模式需要新建 Space，不迁移旧状态。Host 损坏即 Space 丢失，不提供备份恢复。
