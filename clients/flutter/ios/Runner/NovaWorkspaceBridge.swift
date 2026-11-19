import Flutter
import Foundation
import UIKit

final class NovaWorkspaceBridge {
  private let channel: FlutterMethodChannel
  private let initialization = DispatchQueue(label:"nova.workspace.initialize")
  private var spaceId: String?
  private var scopeObserver: NSObjectProtocol?
  private var ready = false // main queue only
  private let owner = UUID().uuidString
  private var executions = Set<String>() // owned by this Flutter engine
  private func nativeID(_ id: String) -> String { owner + "-" + id }
  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name:"nova/workspace/v1", binaryMessenger:messenger)
    channel.setMethodCallHandler { [weak self] call, reply in self?.handle(call, reply:reply) }
    scopeObserver = NotificationCenter.default.addObserver(forName: NovaSpaceScope.changed, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.ready = false
      for id in self.executions { _ = NovaShellRuntime.cancelID(self.nativeID(id)) }
    }
  }
  deinit {
    if let observer = scopeObserver { NotificationCenter.default.removeObserver(observer) }
    for id in executions { _ = NovaShellRuntime.cancelID(nativeID(id)) }
  }
  private func handle(_ call: FlutterMethodCall, reply: @escaping FlutterResult) {
    let args = call.arguments as? [String:Any] ?? [:]
    switch call.method {
    case "initialize":
      guard let selected = try? NovaSpaceScope.standaloneID() else { reply(FlutterError(code:"local_runtime_unavailable",message:nil,details:nil)); return }
      guard let root = args["root_path"] as? String,
        let support = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask).first,
        NovaWorkspaceRequest.validRoot(root, support:support, spaceID:selected) else {
        reply(FlutterError(code:"invalid_workspace",message:"Expected the app support workspace.",details:nil)); return
      }
      guard let archive = Bundle.main.url(forResource:"NovaAlpine",withExtension:nil) else {
        reply(FlutterError(code:"runtime_resources_missing",message:"Bundled Alpine filesystem is missing.",details:nil)); return
      }
      initialization.async {
        do {
          try NovaShellRuntime.prepareArchive(archive.path, root:support.appendingPathComponent("spaces").appendingPathComponent(selected).appendingPathComponent("nova-linux-v1").path, workspace:root)
          DispatchQueue.main.async {
            guard (try? NovaSpaceScope.standaloneID()) == selected else { reply(FlutterError(code:"workspace_scope_changed",message:nil,details:nil)); return }
            self.spaceId = selected; self.ready = true; reply(["ready":true,"platform":"ios"])
          }
        } catch { DispatchQueue.main.async {
          let restart = error.localizedDescription == "space_runtime_restart_required"
          reply(FlutterError(code:restart ? "space_runtime_restart_required" : "runtime_initialization_failed",message:restart ? "切换空间后请完全退出并重新打开 App 以使用本地终端" : error.localizedDescription,details:nil))
        } }
      }
    case "execute":
      guard ready, spaceId == (try? NovaSpaceScope.standaloneID()) else { reply(FlutterError(code:"runtime_not_initialized",message:"Initialize the workspace first.",details:nil)); return }
      do {
        let request = try NovaWorkspaceRequest(args)
        guard !executions.contains(request.id) else { throw NovaWorkspaceRequest.Invalid() }
        let id = nativeID(request.id)
        executions.insert(request.id)
        var background = UIBackgroundTaskIdentifier.invalid
        background = UIApplication.shared.beginBackgroundTask(withName:"nova-shell") {
          _ = NovaShellRuntime.cancelID(id)
          if background != .invalid { UIApplication.shared.endBackgroundTask(background); background = .invalid }
        }
        NovaShellRuntime.executeID(id, command:request.command, cwd:request.cwd, environment:request.environment, timeout:request.timeout) { [weak self] value in
          DispatchQueue.main.async {
            self?.executions.remove(request.id)
            if background != .invalid { UIApplication.shared.endBackgroundTask(background); background = .invalid }
            reply(value)
          }
        }
      } catch { reply(FlutterError(code:"invalid_execution",message:"Invalid workspace command arguments.",details:nil)) }
    case "cancel":
      guard let id = args["id"] as? String, NovaWorkspaceRequest.validID(id) else { reply(["accepted":false]); return }
      reply(["accepted":executions.contains(id) && NovaShellRuntime.cancelID(nativeID(id))])
    default: reply(FlutterMethodNotImplemented)
    }
  }
}
