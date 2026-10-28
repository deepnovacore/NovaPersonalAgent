import { t } from '../../locale.mjs';
export const PHONE_STATES = {
    idle: [t("建立设备连接"), t("在 iPhone 上继续与这台电脑的 Nova 对话。首次连接只需扫码。"), t("启用手机连接"), 'enable'],
    not_installed: [t("还差一个安全连接"), t("在电脑和 iPhone 安装 Tailscale，登录同一账号，然后回来继续。"), t("下载 Tailscale"), 'install'],
    needs_login: [t("连接同一 Tailscale 网络"), t("在电脑和 iPhone 上打开 Tailscale，登录同一账号并连接。完成后回来重新检测。"), t("打开 Tailscale"), 'login'],
    needs_serve: [t("设备已在线"), t("允许同一 Tailscale 网络中的设备连接这台 Nova。连接仍需扫码授权。"), t("开启安全连接"), 'network'],
    conflict: [t("已有其他服务使用此地址"), t("Nova 不会覆盖现有转发。可在高级设置填写另一个已配置的安全地址。"), t("查看配置帮助"), 'help'],
    public_endpoint: [t("此地址已公开到互联网"), t("请为 Nova 使用私有 Tailscale Serve 地址，再重新检测。"), t("查看配置帮助"), 'help'],
    unavailable: [t("暂时无法读取网络状态"), t("请确认 Tailscale 正在运行，然后重试。也可以在高级设置填写地址。"), t("重新检测"), 'status'],
    service_unavailable: [t("手机服务未能启动"), t("请检查 Nova 的语音配置。若使用已有服务，请检查高级设置中的连接信息。"), t("重试连接"), 'enable'],
    qr_unavailable: [t("二维码暂时不可用"), t("请确认这台 Mac 已安装 Xcode Command Line Tools，然后重试。"), t("重试"), 'refresh'],
    unsupported: [t("目前支持在 Mac 上连接"), t("请在 Mac 版 Nova 打开此页面。"), '', 'status'],
    ready: [t("用 iPhone 扫码"), t("打开手机 Nova → 连接主机 → 扫码连接。"), t("重新生成二维码"), 'refresh'],
    invalidated: [t("二维码已取消"), t("重新生成二维码，即可继续配对。"), t("重新生成二维码"), 'refresh'],
    paired: [t("iPhone 已配对"), t("在手机上开始对话。你也可以继续连接另一台设备。"), t("连接另一台设备"), 'refresh'],
};
