// Window-scoped Safari input. AX is used only for native key-window identity metadata.
// No control tree, hit testing, AX actions/value writes, window raise, pointer warp or global input.
import AppKit
import ApplicationServices
import Carbon
import ScreenCaptureKit
import Darwin

@_silgen_name("_AXUIElementGetWindow") private func nativeWindowID(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError
private struct Refusal: Error {let code: String}
private func reject(_ code: String) throws -> Never {throw Refusal(code: code)}
private struct Binding: Equatable {
    let pid: Int32, windowID: UInt32, started: Double, bounds: CGRect, keyWindow: UInt32
    var identity: String {"\(pid):\(windowID):\(started):\(bounds.origin.x):\(bounds.origin.y):\(bounds.width):\(bounds.height):\(keyWindow)"}
}

@main @MainActor struct MacGUI {
    private struct Front: Equatable {
        let pid: Int32, windowID: UInt32, started: Double
        var json: [String: Any] {["pid":pid,"windowId":windowID,"started":started]}
    }
    private static func frontApp() throws -> NSRunningApplication {
        // WindowServer query stays current even while this helper's main runloop is sleeping.
        guard let sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW|RTLD_GLOBAL) else {try reject("needs_user_action")}
        defer {dlclose(sky)}
        typealias GetFront = @convention(c)(UnsafeMutableRawPointer)->Int32
        typealias GetPID = @convention(c)(UnsafeRawPointer,UnsafeMutablePointer<Int32>)->Int32
        guard let frontSymbol=dlsym(sky,"_SLPSGetFrontProcess"),let pidSymbol=dlsym(UnsafeMutableRawPointer(bitPattern:-2),"GetProcessPID") else {try reject("needs_user_action")}
        let getFront=unsafeBitCast(frontSymbol,to:GetFront.self),getPID=unsafeBitCast(pidSymbol,to:GetPID.self)
        var psn=ProcessSerialNumber(),pid:Int32=0
        guard getFront(&psn)==0,getPID(&psn,&pid)==0,pid>0,let app=NSRunningApplication(processIdentifier:pid),!app.isTerminated else {try reject("needs_user_action")}
        return app
    }
    private static func front() throws -> Front {
        let app=try frontApp()
        guard let started=app.launchDate?.timeIntervalSince1970 else {try reject("needs_user_action")}
        var value: CFTypeRef?, wid: CGWindowID=0
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier),kAXFocusedWindowAttribute as CFString,&value)==AXError.success,
              let value=value,CFGetTypeID(value)==AXUIElementGetTypeID(),
              nativeWindowID(unsafeBitCast(value,to:AXUIElement.self),&wid)==AXError.success,wid>0 else {try reject("needs_user_action")}
        return Front(pid:app.processIdentifier,windowID:wid,started:started)
    }
    private static func focusRecord(_ pid: Int32,_ wid: UInt32,_ active: Bool) throws {
        guard let sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW|RTLD_GLOBAL) else {try reject("needs_user_action")}
        defer {dlclose(sky)}
        typealias Lookup = @convention(c)(Int32,UnsafeMutableRawPointer)->Int32
        typealias FocusPost = @convention(c)(UnsafeRawPointer,UnsafePointer<UInt8>)->Int32
        guard let lookupSymbol=dlsym(UnsafeMutableRawPointer(bitPattern:-2),"GetProcessForPID"),let postSymbol=dlsym(sky,"SLPSPostEventRecordTo") else {try reject("needs_user_action")}
        let lookup=unsafeBitCast(lookupSymbol,to:Lookup.self),post=unsafeBitCast(postSymbol,to:FocusPost.self)
        var psn=ProcessSerialNumber(),bytes=[UInt8](repeating:0,count:248)
        guard lookup(pid,&psn)==0 else {try reject("needs_user_action")}
        bytes[4]=248;bytes[8]=13;bytes[138]=active ? 1 : 2
        for i in 0..<4 {bytes[60+i]=UInt8((wid >> (i*8)) & 255)}
        let result=withUnsafePointer(to:&psn){p in bytes.withUnsafeBufferPointer{b in post(UnsafeRawPointer(p),b.baseAddress!)}}
        guard result==0 else {try reject("action_failed")}
    }
    private static func restoreFocus(_ request: [String: Any]) throws {
        // Restoration follows the user's CURRENT front window, including an app switch during a click.
        guard let pid=request["pid"] as? Int32, pid>0,let wid=request["windowId"] as? UInt32,wid>0,
              let started=request["targetStarted"] as? Double,started.isFinite,started>0 else {try reject("invalid_configuration")}
        let currentPid=try frontApp().processIdentifier
        if let app=NSRunningApplication(processIdentifier:pid),app.bundleIdentifier=="com.apple.Safari",app.launchDate?.timeIntervalSince1970==started {
            if request["releasePointer"] as? Bool==true {
                guard let group=request["clickGroup"] as? Int64,(1...2147483647).contains(group) else {try reject("invalid_configuration")}
                let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],0) as? [[String:Any]] ?? []
                if let window=windows.first(where:{($0[kCGWindowNumber as String] as? UInt32)==wid && ($0[kCGWindowOwnerPID as String] as? Int32)==pid}),
                   let values=window[kCGWindowBounds as String] as? NSDictionary,let bounds=CGRect(dictionaryRepresentation:values) {
                    guard let sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW|RTLD_GLOBAL) else {try reject("needs_user_action")}
                    defer {dlclose(sky)}
                    typealias Post = @convention(c)(Int32,OpaquePointer)->Void
                    typealias Field = @convention(c)(OpaquePointer,UInt32,Int64)->Void
                    typealias Location = @convention(c)(OpaquePointer,Double,Double)->Void
                    let point=CGPoint(x:bounds.minX-1,y:bounds.minY-1)
                    guard let postSymbol=dlsym(sky,"SLEventPostToPid"),let fieldSymbol=dlsym(sky,"SLEventSetIntegerValueField"),let locationSymbol=dlsym(sky,"CGEventSetWindowLocation"),
                          let event=CGEvent(mouseEventSource:CGEventSource(stateID:.hidSystemState),mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left) else {try reject("needs_user_action")}
                    let post=unsafeBitCast(postSymbol,to:Post.self),field=unsafeBitCast(fieldSymbol,to:Field.self),location=unsafeBitCast(locationSymbol,to:Location.self)
                    event.flags=[]
                    withExtendedLifetime(event) {
                        let raw=OpaquePointer(Unmanaged.passUnretained(event).toOpaque())
                        for (key,value) in [(UInt32(0),Int64(3)),(1,1),(3,0),(7,3),(40,Int64(pid)),(51,Int64(wid)),(58,group),(91,Int64(wid)),(92,Int64(wid))] {field(raw,key,value)}
                        location(raw,point.x,point.y);post(pid,raw)
                    }
                    usleep(200000)
                }
            }
            if currentPid != pid {
            // Always restore the current front window, even if target defocus fails.
                do {try focusRecord(pid,wid,false)} catch {let current=try front();try focusRecord(current.pid,current.windowID,true);throw error}
            }
        }
        let current=try front()
        try focusRecord(current.pid,current.windowID,true)
        guard try front()==current else {try reject("screen_changed")}
    }
    private static func beginFocus(_ request: [String: Any],_ binding: Binding) throws {
        guard let previous=request["focus"] as? [String:Any],let pid=previous["pid"] as? Int32,
              let wid=previous["windowId"] as? UInt32,let started=previous["started"] as? Double,
              request["targetStarted"] as? Double==binding.started,
              try front()==Front(pid:pid,windowID:wid,started:started) else {try reject("screen_changed")}
        if pid != binding.pid {
            try focusRecord(pid,wid,false)
            try focusRecord(binding.pid,binding.windowID,true)
            usleep(50000)
        }
    }
    private static func bind(_ request: [String: Any]) throws -> Binding {
        guard let pidNumber=request["pid"] as? NSNumber, let windowNumber=request["windowId"] as? NSNumber,
              pidNumber.doubleValue>0, pidNumber.doubleValue<=Double(Int32.max), pidNumber.doubleValue.rounded()==pidNumber.doubleValue,
              windowNumber.doubleValue>0, windowNumber.doubleValue<=Double(UInt32.max), windowNumber.doubleValue.rounded()==windowNumber.doubleValue else {try reject("invalid_configuration")}
        let pid=pidNumber.int32Value, wid=windowNumber.uint32Value
        guard let app=NSRunningApplication(processIdentifier: pid), app.bundleIdentifier=="com.apple.Safari", !app.isTerminated,
              let started=app.launchDate?.timeIntervalSince1970 else {try reject("needs_user_action")}
        let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],0) as? [[String: Any]] ?? []
        guard let window=windows.first(where: {($0[kCGWindowNumber as String] as? UInt32)==wid && ($0[kCGWindowOwnerPID as String] as? Int32)==pid}),
              (window[kCGWindowLayer as String] as? Int)==0, let values=window[kCGWindowBounds as String] as? NSDictionary,
              let bounds=CGRect(dictionaryRepresentation: values), bounds.width>0, bounds.height>0,
              bounds.width<=8192, bounds.height<=8192 else {try reject("screen_changed")}
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as CFString, &focused)==AXError.success,
              let focused=focused, CFGetTypeID(focused)==AXUIElementGetTypeID() else {try reject("needs_user_action")}
        var keyWindow: CGWindowID=0
        guard nativeWindowID(unsafeBitCast(focused,to:AXUIElement.self), &keyWindow)==AXError.success else {try reject("needs_user_action")}
        return Binding(pid:pid,windowID:wid,started:started,bounds:bounds,keyWindow:keyWindow)
    }
    private static func metadata(_ binding: Binding) -> [String: Any] {
        ["target":binding.identity,"width":binding.bounds.width,"height":binding.bounds.height,"keyWindowMatches":binding.keyWindow==binding.windowID]
    }
    static func execute(_ request: [String: Any]) async throws -> [String: Any] {
        if request["op"] as? String=="focusRestore" {try restoreFocus(request);return ["restored":true]}
        let binding=try bind(request)
        guard let operation=request["op"] as? String else {try reject("invalid_configuration")}
        if operation=="target" || operation=="size" || operation=="connect" {return metadata(binding)}
        if operation=="focusSnapshot" {return ["focus":try front().json,"targetStarted":binding.started]}
        if operation=="screenshot" {
            guard #available(macOS 14.0, *) else {try reject("needs_user_action")}
            let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false)
            guard let window=content.windows.first(where: {$0.windowID==binding.windowID && $0.owningApplication?.processID==binding.pid}) else {try reject("screen_changed")}
            let filter=SCContentFilter(desktopIndependentWindow:window), config=SCStreamConfiguration()
            config.width=Int(binding.bounds.width)*2; config.height=Int(binding.bounds.height)*2
            config.showsCursor=false; config.ignoreShadowsSingleWindow=true
            let image=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
            guard try bind(request)==binding, image.width==config.width, image.height==config.height,
                  let png=NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:]), png.count<=30_000_000 else {try reject("screen_changed")}
            return ["image":"data:image/png;base64,"+png.base64EncodedString(),"target":binding.identity]
        }
        guard binding.keyWindow==binding.windowID, request["target"] as? String==binding.identity,
              !IsSecureEventInputEnabled() else {try reject("screen_changed")}
        guard let sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW|RTLD_GLOBAL),
              let postSymbol=dlsym(sky,"SLEventPostToPid"), let locationSymbol=dlsym(sky,"CGEventSetWindowLocation"),
              let fieldSymbol=dlsym(sky,"SLEventSetIntegerValueField") else {try reject("needs_user_action")}
        defer {dlclose(sky)}
        typealias Post = @convention(c)(Int32,OpaquePointer)->Void
        typealias Location = @convention(c)(OpaquePointer,Double,Double)->Void
        typealias Field = @convention(c)(OpaquePointer,UInt32,Int64)->Void
        let post=unsafeBitCast(postSymbol,to:Post.self), location=unsafeBitCast(locationSymbol,to:Location.self), field=unsafeBitCast(fieldSymbol,to:Field.self)
        let source=CGEventSource(stateID:operation=="Tap" ? .hidSystemState : .privateState)
        let clickGroup=request["clickGroup"] as? Int64 ?? 0
        func fresh() throws {guard try bind(request)==binding, !IsSecureEventInputEnabled() else {try reject("screen_changed")}}
        func send(_ event: CGEvent, point: CGPoint?=nil, publicOnly: Bool=false, phase: Int64=3) {
            let raw=OpaquePointer(Unmanaged.passUnretained(event).toOpaque())
            field(raw,40,Int64(binding.pid)); field(raw,51,Int64(binding.windowID))
            if let point=point {
                // Both PID routes use screen-space window location; model coordinates are local points.
                location(raw,point.x+binding.bounds.minX,point.y+binding.bounds.minY); field(raw,91,Int64(binding.windowID)); field(raw,92,Int64(binding.windowID))
                if operation=="Tap" {field(raw,0,phase);field(raw,3,0);field(raw,7,3);field(raw,58,clickGroup)}
            }
            if publicOnly {event.postToPid(binding.pid)} else {post(binding.pid,raw)}
        }
        func point() throws -> CGPoint {
            guard let x=request["x"] as? Double, let y=request["y"] as? Double, x.isFinite,y.isFinite,
                  x>=0,y>=0,x<binding.bounds.width,y<binding.bounds.height else {try reject("needs_user_action")}
            return CGPoint(x:x,y:y)
        }
        switch operation {
        case "Tap":
            let local=try point(), screen=CGPoint(x:local.x+binding.bounds.minX,y:local.y+binding.bounds.minY)
            guard let hold=request["holdMs"] as? Int, (10...1000).contains(hold),(1...2147483647).contains(clickGroup),
                  let move=CGEvent(mouseEventSource:source,mouseType:.mouseMoved,mouseCursorPosition:screen,mouseButton:.left),
                  let down=CGEvent(mouseEventSource:source,mouseType:.leftMouseDown,mouseCursorPosition:screen,mouseButton:.left),
                  let up=CGEvent(mouseEventSource:source,mouseType:.leftMouseUp,mouseCursorPosition:screen,mouseButton:.left) else {try reject("needs_user_action")}
            down.flags=[]; up.flags=[]; move.flags=[]
            down.setIntegerValueField(.mouseEventClickState,value:1); up.setIntegerValueField(.mouseEventClickState,value:1)
            var restored=false
            defer {if !restored {var recovery=request;recovery["releasePointer"]=true;try? restoreFocus(recovery)}}
            try fresh();try beginFocus(request,binding)
            send(move,point:local,phase:2);usleep(12000)
            // Screen-off primer opens the browser activation gate without touching a page element.
            let offscreen=CGPoint(x:-1,y:-1)
            for (kind,phase) in [(CGEventType.leftMouseDown,Int64(1)),(.leftMouseUp,Int64(2))] {
                guard let event=CGEvent(mouseEventSource:source,mouseType:kind,mouseCursorPosition:CGPoint(x:binding.bounds.minX-1,y:binding.bounds.minY-1),mouseButton:.left) else {try reject("action_failed")}
                event.flags=[];event.setIntegerValueField(.mouseEventClickState,value:1)
                send(event,point:offscreen,phase:phase);usleep(30000)
            }
            try fresh();send(down,point:local);usleep(useconds_t(hold*1000));send(up,point:local);usleep(200000)
            try fresh();try restoreFocus(request);restored=true
            return ["posted":true,"restored":true]
        case "Input":
            guard let text=request["value"] as? String, !text.isEmpty,text.utf16.count<=200 else {try reject("needs_user_action")}
            for scalar in text.unicodeScalars {
                let units=Array(String(scalar).utf16)
                guard let down=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:true),let up=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:false) else {try reject("action_failed")}
                for event in [down,up] {event.flags=[];units.withUnsafeBufferPointer {event.keyboardSetUnicodeString(stringLength:units.count,unicodeString:$0.baseAddress!)}}
                // ponytail: 200 UTF-16 units bound paced writes; split longer text across approved actions.
                try fresh(); send(down); usleep(30000); send(up); usleep(30000)
            }
        case "KeyboardPress":
            guard let name=request["keyName"] as? String else {try reject("needs_user_action")}
            let keys: [String:(CGKeyCode,CGEventFlags)] = ["Command+A":(0,.maskCommand),"Meta+A":(0,.maskCommand),"Return":(36,[]),"Enter":(36,[]),"Tab":(48,[]),"Escape":(53,[]),"Backspace":(51,[])]
            guard let (code,flags)=keys[name],let down=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:true),let up=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:false) else {try reject("needs_user_action")}
            down.flags=flags;up.flags=flags;try fresh();send(down);usleep(10000);send(up)
        case "Scroll":
            let local=try point(), screen=CGPoint(x:local.x+binding.bounds.minX,y:local.y+binding.bounds.minY)
            guard let dx=request["dx"] as? Int32,let dy=request["dy"] as? Int32,abs(Int64(dx))<=8192,abs(Int64(dy))<=8192,
                  let event=CGEvent(scrollWheelEvent2Source:source,units:.pixel,wheelCount:2,wheel1:dy,wheel2:dx,wheel3:0) else {try reject("needs_user_action")}
            event.flags=[];event.location=screen;try fresh();send(event,point:local,publicOnly:true)
        default:try reject("needs_user_action")
        }
        try fresh()
        return ["posted":true] // A transport receipt, never a business-completion claim.
    }
    static func main() async {
        do {
            let input=FileHandle.standardInput.readDataToEndOfFile()
            guard input.count<=65536,let request=(try? JSONSerialization.jsonObject(with:input)) as? [String:Any] else {try reject("invalid_configuration")}
            let result=try await execute(request)
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:result))
        } catch {
            let code=(error as? Refusal)?.code ?? "action_failed"
            FileHandle.standardOutput.write((try? JSONSerialization.data(withJSONObject:["error":code])) ?? Data())
            exit(1)
        }
    }
}
