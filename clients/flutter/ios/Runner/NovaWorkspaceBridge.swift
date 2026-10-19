import Flutter
import Foundation
import UIKit

final class NovaWorkspaceBridge {
  private let channel: FlutterMethodChannel
  private let initialization = DispatchQueue(label:"nova.workspace.initialize")
  private var ready = false // main queue only
  private let owner = UUID().uuidString
  private var executions = Set<String>() // owned by this Flutter engine
  private func nativeID(_ id: String) -> String { owner + "-" + id }
  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name:"nova/workspace/v1", binaryMessenger:messenger)
    channel.setMethodCallHandler { [weak self] call, reply in self?.handle(call, reply:reply) }
  }
  deinit {
    for id in executions { _ = NovaShellRuntime.cancelID(nativeID(id)) }
  }
  private func handle(_ call: FlutterMethodCall, reply: @escaping FlutterResult) {
    let args = call.arguments as? [String:Any] ?? [:]
    switch call.method {
    case "initialize":
      guard let root = args["root_path"] as? String,
        let support = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask).first,
        NovaWorkspaceRequest.validRoot(root, support:support) else {
        reply(FlutterError(code:"invalid_workspace",message:"Expected the app support workspace.",details:nil)); return
      }
      guard let archive = Bundle.main.url(forResource:"NovaAlpine",withExtension:nil) else {
        reply(FlutterError(code:"runtime_resources_missing",message:"Bundled Alpine filesystem is missing.",details:nil)); return
      }
      initialization.async {
        do {
          try NovaShellRuntime.prepareArchive(archive.path, root:support.appendingPathComponent("nova-linux-v1").path, workspace:root)
          DispatchQueue.main.async { self.ready = true; reply(["ready":true,"platform":"ios"]) }
        } catch { DispatchQueue.main.async { reply(FlutterError(code:"runtime_initialization_failed",message:error.localizedDescription,details:nil)) } }
      }
    case "execute":
      guard ready else { reply(FlutterError(code:"runtime_not_initialized",message:"Initialize the workspace first.",details:nil)); return }
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
