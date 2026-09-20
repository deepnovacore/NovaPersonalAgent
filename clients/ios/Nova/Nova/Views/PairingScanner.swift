import AVFoundation
import SwiftUI
import VisionKit

struct PairingScanner: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var allowed = false
    @State private var error = ""
    var body: some View {
        NavigationStack {
            Group {
                if allowed && error.isEmpty {
                    ScannerCamera(onScan: onScan, onError: { error = $0 })
                        .overlay(alignment: .bottom) {
                            Text(L10n.text("扫描 Mac 上的 Nova 配对二维码"))
                                .padding().background(.regularMaterial, in: Capsule()).padding()
                        }
                } else {
                    ContentUnavailableView(error.isEmpty ? L10n.text("正在准备相机") : L10n.text("无法扫码"), systemImage: "qrcode.viewfinder",
                                           description: Text(error))
                }
            }
            .navigationTitle(L10n.text("扫码连接")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L10n.text("取消")) { dismiss() } } }
        }
        .task {
            guard DataScannerViewController.isSupported else {
                error = L10n.text("此设备不支持扫码，请使用手动连接。"); return
            }
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            guard !Task.isCancelled else { return }
            if granted && DataScannerViewController.isAvailable { allowed = true }
            else { error = L10n.text("请在 iPhone 设置中允许 Nova 使用相机，或使用手动连接。") }
        }
    }
}

private struct ScannerCamera: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onError: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan, onError: onError) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        do { try scanner.startScanning() }
        catch { DispatchQueue.main.async { onError(L10n.text("相机无法启动，请重试或使用手动连接。")) } }
        return scanner
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) { controller.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        let onError: (String) -> Void
        var delivered = false
        init(onScan: @escaping (String) -> Void, onError: @escaping (String) -> Void) { self.onScan = onScan; self.onError = onError }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for case let .barcode(barcode) in addedItems {
                if let text = barcode.payloadStringValue {
                    delivered = true; scanner.stopScanning(); onScan(text); return
                }
            }
        }
        func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            scanner.stopScanning(); onError(L10n.text("相机暂时不可用，请重试或使用手动连接。"))
        }
    }
}
