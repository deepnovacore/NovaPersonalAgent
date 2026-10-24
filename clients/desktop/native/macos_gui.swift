// Window-bound background input: capability-based AX operations and process-targeted events.
// Never raise a window, defocus the user's app, warp the pointer, or emit global input.
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
    private static let keys: [String:(CGKeyCode,CGEventFlags)] = ["command+a":(0,.maskCommand),"cmd+a":(0,.maskCommand),"meta+a":(0,.maskCommand),"return":(36,[]),"enter":(36,[]),"tab":(48,[]),"escape":(53,[]),"backspace":(51,[])]
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
        // Release only input sent to this process generation; never change foreground focus.
        guard let pid=request["pid"] as? Int32, pid>0,let wid=request["windowId"] as? UInt32,wid>0,
              let started=request["targetStarted"] as? Double,started.isFinite,started>0 else {try reject("invalid_configuration")}
        if let app=NSRunningApplication(processIdentifier:pid),app.bundleIdentifier != nil,app.launchDate?.timeIntervalSince1970==started {
            if let key=request["releaseKey"] as? String {
                let codes:[CGKeyCode]
                if key=="unicode" {codes=[0]}
                else if let (code,flags)=keys[key.lowercased()] {codes=flags.contains(.maskCommand) ? [code,55] : [code]}
                else {try reject("invalid_configuration")}
                for code in codes {
                    guard let event=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false) else {try reject("action_failed")}
                    event.flags=[];event.postToPid(pid)
                }
            }
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
        }
    }
    private static func bind(_ request: [String: Any]) throws -> Binding {
        guard let pidNumber=request["pid"] as? NSNumber, let windowNumber=request["windowId"] as? NSNumber,
              pidNumber.doubleValue>0, pidNumber.doubleValue<=Double(Int32.max), pidNumber.doubleValue.rounded()==pidNumber.doubleValue,
              windowNumber.doubleValue>0, windowNumber.doubleValue<=Double(UInt32.max), windowNumber.doubleValue.rounded()==windowNumber.doubleValue else {try reject("invalid_configuration")}
        let pid=pidNumber.int32Value, wid=windowNumber.uint32Value
        guard let app=NSRunningApplication(processIdentifier: pid), app.bundleIdentifier != nil, !app.isTerminated,
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
    private static var axTimedOut=false
    private static func attribute(_ element: AXUIElement,_ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let status=AXUIElementCopyAttributeValue(element,name as CFString,&value)
        if status == .cannotComplete {axTimedOut=true}
        guard status == .success else {return nil}
        return value
    }
    private static func writable(_ element: AXUIElement,_ name: String) -> Bool {
        var result: DarwinBoolean=false
        return AXUIElementIsAttributeSettable(element,name as CFString,&result) == .success && result.boolValue
    }
    private static func ownerWindow(_ element: AXUIElement) -> UInt32? {
        guard let value=attribute(element,kAXWindowAttribute),CFGetTypeID(value)==AXUIElementGetTypeID() else {return nil}
        var id:CGWindowID=0
        guard nativeWindowID(unsafeBitCast(value,to:AXUIElement.self),&id) == .success else {return nil}
        return id
    }
    private static func receiver(_ binding: Binding) throws -> AXUIElement {
        let app=AXUIElementCreateApplication(binding.pid)
        AXUIElementSetMessagingTimeout(app,1)
        let element:AXUIElement
        if let value=attribute(app,kAXFocusedUIElementAttribute),CFGetTypeID(value)==AXUIElementGetTypeID() {
            element=unsafeBitCast(value,to:AXUIElement.self)
        } else {
            // Some background apps expose focus only on the editor, not on the application.
            guard let value=attribute(app,kAXFocusedWindowAttribute),CFGetTypeID(value)==AXUIElementGetTypeID() else {try reject("operation_unsupported")}
            let window=unsafeBitCast(value,to:AXUIElement.self)
            var id:CGWindowID=0
            guard nativeWindowID(window,&id) == .success,id==binding.windowID else {try reject("screen_changed")}
            var queue=[window],index=0,candidates:[AXUIElement]=[]
            let deadline=Date().addingTimeInterval(1)
            while index<queue.count {
                guard index<2000,Date()<deadline else {try reject("operation_unsupported")}
                let node=queue[index];index+=1
                if [kAXTextFieldRole,kAXTextAreaRole,kAXComboBoxRole].contains(attribute(node,kAXRoleAttribute) as? String ?? ""),attribute(node,kAXFocusedAttribute) as? Bool == true {
                    if !candidates.contains(where:{CFEqual($0,node)}) {candidates.append(node)}
                    guard candidates.count==1 else {try reject("operation_unsupported")}
                } else if let children=attribute(node,kAXChildrenAttribute) as? [AXUIElement] {queue.append(contentsOf:children.prefix(2001))}
            }
            guard let found=candidates.first else {try reject("operation_unsupported")}
            element=found
        }
        guard ownerWindow(element)==binding.windowID else {try reject("screen_changed")}
        guard attribute(element,kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else {try reject("operation_unsupported")}
        return element
    }
    private static func focusOrPress(_ binding: Binding,_ point: CGPoint,editorOnly: Bool=false) throws -> String? {
        let app=AXUIElementCreateApplication(binding.pid)
        AXUIElementSetMessagingTimeout(app,1)
        var hit:AXUIElement?
        guard AXUIElementCopyElementAtPosition(app,Float(point.x+binding.bounds.minX),Float(point.y+binding.bounds.minY),&hit) == .success,let element=hit else {return nil}
        guard ownerWindow(element)==binding.windowID else {try reject("screen_changed")}
        let role=attribute(element,kAXRoleAttribute) as? String
        if [kAXTextFieldRole,kAXTextAreaRole,kAXComboBoxRole].contains(role ?? ""), writable(element,kAXFocusedAttribute) {
            guard AXUIElementSetAttributeValue(element,kAXFocusedAttribute as CFString,kCFBooleanTrue) == .success else {try reject("action_failed")}
            for _ in 0..<25 {
                if let current=try? receiver(binding),CFEqual(current,element),attribute(element,kAXFocusedAttribute) as? Bool == true {return "editor"}
                usleep(10000)
            }
            try reject("action_failed")
        }
        if editorOnly {try reject("operation_unsupported")}
        var actions:CFArray?
        guard AXUIElementCopyActionNames(element,&actions) == .success,(actions as? [String] ?? []).contains(kAXPressAction) else {return nil}
        guard AXUIElementPerformAction(element,kAXPressAction as CFString) == .success else {try reject("action_failed")}
        return "press"
    }
    private static func editNative(_ binding: Binding,_ text: String?,selectAll: Bool=false,replace: Bool=false) throws -> Bool {
        let element=try receiver(binding)
        let textAttribute=kAXValueAttribute
        guard let current=attribute(element,kAXValueAttribute) as? String,
              let selection=attribute(element,kAXSelectedTextRangeAttribute),CFGetTypeID(selection)==AXValueGetTypeID() else {return false}
        var range=CFRange()
        guard AXValueGetValue(unsafeBitCast(selection,to:AXValue.self),.cfRange,&range),
              range.location>=0,range.length>=0,range.location<=current.utf16.count,range.length<=current.utf16.count-range.location else {try reject("screen_changed")}
        let selected=NSRange(location:range.location,length:range.length)
        guard Range(selected,in:current) != nil else {try reject("operation_unsupported")}
        if !writable(element,kAXSelectedTextRangeAttribute) || (!selectAll && !writable(element,textAttribute)) {return false}
        guard CFEqual(try receiver(binding),element),attribute(element,kAXValueAttribute) as? String==current,
              let latestSelection=attribute(element,kAXSelectedTextRangeAttribute),CFEqual(selection,latestSelection) else {try reject("screen_changed")}
        if selectAll {range=CFRange(location:0,length:current.utf16.count)}
        else {
            let replacement=text ?? "",next=replace ? replacement : (current as NSString).replacingCharacters(in:selected,with:replacement)
            let write=AXUIElementSetAttributeValue(element,textAttribute as CFString,next as CFString)
            if write == .attributeUnsupported || write == .notImplemented {return false}
            guard write == .success else {try reject("editor_write_rejected") }
            guard CFEqual(try receiver(binding),element),attribute(element,kAXValueAttribute) as? String==next else {try reject("editor_readback_changed")}
            range=CFRange(location:(replace ? 0 : range.location)+replacement.utf16.count,length:0)
        }
        guard CFEqual(try receiver(binding),element),let value=AXValueCreate(.cfRange,&range),
              AXUIElementSetAttributeValue(element,kAXSelectedTextRangeAttribute as CFString,value) == .success else {try reject("action_failed")}
        guard let readback=attribute(element,kAXSelectedTextRangeAttribute),CFEqual(value,readback) else {try reject("action_failed")}
        return true
    }
    private static func metadata(_ binding: Binding) -> [String: Any] {
        ["target":binding.identity,"width":binding.bounds.width,"height":binding.bounds.height,"keyWindowMatches":binding.keyWindow==binding.windowID]
    }
    static func execute(_ request: [String: Any]) async throws -> [String: Any] {
        if request["op"] as? String=="focusRestore" {try restoreFocus(request);return ["restored":true]}
        if request["op"] as? String=="applicationTarget" {
            guard let query=request["application"] as? String,!query.isEmpty,query.count<=200 else {try reject("invalid_configuration")}
            let apps=NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && ($0.bundleIdentifier==query || $0.localizedName==query) }
            guard apps.count==1,let app=apps.first else {try reject("application_not_found_or_ambiguous")}
            let ax=AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(ax,1)
            guard let value=attribute(ax,kAXFocusedWindowAttribute),CFGetTypeID(value)==AXUIElementGetTypeID() else {try reject("needs_user_action")}
            var id:CGWindowID=0
            guard nativeWindowID(unsafeBitCast(value,to:AXUIElement.self),&id) == .success else {try reject("needs_user_action")}
            let selected=try bind(["pid":app.processIdentifier,"windowId":id])
            return ["pid":selected.pid,"windowId":selected.windowID,"title":String((attribute(unsafeBitCast(value,to:AXUIElement.self),kAXTitleAttribute) as? String ?? "").prefix(200)),"target":selected.identity,"application":["name":app.localizedName ?? query,"bundleId":app.bundleIdentifier ?? "","path":app.bundleURL?.standardizedFileURL.path ?? ""]]
        }
        let binding=try bind(request)
        guard let operation=request["op"] as? String else {try reject("invalid_configuration")}
        if operation=="target" || operation=="size" || operation=="connect" {return metadata(binding)}
        if operation=="editor" {
            guard request["target"] as? String==binding.identity else {try reject("screen_changed")}
            axTimedOut=false
            var result:[String:Any]=["available":false,"status":"unavailable"],content:[[String:String]]=[]
            var truncated=false
            if let element=try? receiver(binding),let value=attribute(element,kAXValueAttribute) as? String {
                truncated=value.count>200
                result=["available":true,"role":attribute(element,kAXRoleAttribute) as? String ?? "","value":String(value.prefix(200)),"source":"accessibility"]
            }
            let app=AXUIElementCreateApplication(binding.pid)
            AXUIElementSetMessagingTimeout(app,0.5)
            if let value=attribute(app,kAXFocusedWindowAttribute),CFGetTypeID(value)==AXUIElementGetTypeID() {
                let window=unsafeBitCast(value,to:AXUIElement.self)
                var id:CGWindowID=0
                guard nativeWindowID(window,&id) == .success,id==binding.windowID else {try reject("screen_changed")}
                var queue=[window],index=0
                let deadline=Date().addingTimeInterval(1)
                while index<queue.count,index<500,content.count<80,Date()<deadline {
                    let node=queue[index];index+=1
                    if attribute(node,kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole {continue}
                    let role=attribute(node,kAXRoleAttribute) as? String ?? ""
                    if [kAXStaticTextRole,kAXButtonRole,kAXTextFieldRole,kAXTextAreaRole,"AXWebArea"].contains(role) {
                        let text=(attribute(node,kAXValueAttribute) as? String) ?? (attribute(node,kAXTitleAttribute) as? String) ?? ""
                        let url=(attribute(node,kAXURLAttribute) as? URL)?.absoluteString ?? ""
                        if text.count>300 || url.count>500 {truncated=true}
                        if !text.isEmpty || !url.isEmpty {content.append(["role":role,"text":String(text.prefix(300)),"url":String(url.prefix(500))])}
                    }
                    if let children=attribute(node,kAXChildrenAttribute) as? [AXUIElement] {queue.append(contentsOf:children.prefix(501))}
                }
                result["native_ui"]=["source":"accessibility","content":content,"truncated":truncated || index<queue.count]
                result["status"]=axTimedOut || Date()>=deadline ? "timeout" : truncated || index<queue.count ? "truncated" : "ok"
            }
            if axTimedOut {result["status"]="timeout"}
            if result["status"] == nil {result["status"]="unavailable"}
            guard try bind(request)==binding else {try reject("screen_changed")}
            return result
        }
        if operation=="focusSnapshot" {return ["focus":["pid":binding.pid,"windowId":binding.windowID,"started":binding.started],"targetStarted":binding.started]}
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
        // Background apps can drop their editor focus between process-scoped actions.
        if ["Input","KeyboardPress"].contains(operation),let point=request["editorPoint"] as? [Double],point.count==2 {
            guard point.allSatisfy({$0.isFinite}),point[0]>=0,point[1]>=0,point[0]<binding.bounds.width,point[1]<binding.bounds.height,
                  try focusOrPress(binding,CGPoint(x:point[0],y:point[1]),editorOnly:true)=="editor" else {try reject("operation_unsupported")}
        }
        switch operation {
        case "Tap":
            let local=try point()
            try fresh()
            if let kind=try focusOrPress(binding,local) {try fresh();return ["posted":true,"restored":true,"delivery":"accessibility","editor":kind=="editor"]}
            let screen=CGPoint(x:local.x+binding.bounds.minX,y:local.y+binding.bounds.minY)
            guard let hold=request["holdMs"] as? Int, (10...1000).contains(hold),(1...2147483647).contains(clickGroup),
                  let move=CGEvent(mouseEventSource:source,mouseType:.mouseMoved,mouseCursorPosition:screen,mouseButton:.left),
                  let down=CGEvent(mouseEventSource:source,mouseType:.leftMouseDown,mouseCursorPosition:screen,mouseButton:.left),
                  let up=CGEvent(mouseEventSource:source,mouseType:.leftMouseUp,mouseCursorPosition:screen,mouseButton:.left) else {try reject("needs_user_action")}
            down.flags=[]; up.flags=[]; move.flags=[]
            down.setIntegerValueField(.mouseEventClickState,value:1); up.setIntegerValueField(.mouseEventClickState,value:1)
            try fresh()
            send(move,point:local,phase:2);usleep(12000)
            send(down,point:local);usleep(useconds_t(hold*1000));send(up,point:local);usleep(200000)
            try fresh()
            return ["posted":true,"restored":true,"delivery":"targeted_events"]
        case "Input":
            guard let text=request["value"] as? String, !text.isEmpty,text.utf16.count<=200 else {try reject("needs_user_action")}
            try fresh()
            let mode=request["mode"] as? String ?? "append"
            guard ["append","replace"].contains(mode) else {try reject("invalid_configuration")}
            if try editNative(binding,text,replace:mode=="replace") {try fresh();return ["posted":true,"delivery":"accessibility"]}
            guard mode=="append" else {try reject("operation_unsupported")}
            try focusRecord(binding.pid,binding.windowID,true)
            for scalar in text.unicodeScalars {
                let units=Array(String(scalar).utf16)
                guard let down=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:true),let up=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:false) else {try reject("action_failed")}
                for event in [down,up] {event.flags=[];units.withUnsafeBufferPointer {event.keyboardSetUnicodeString(stringLength:units.count,unicodeString:$0.baseAddress!)}}
                // shortcut: paced writes are limited to 200 UTF-16 units per action.
                try fresh(); send(down); usleep(30000); send(up); usleep(30000)
            }
        case "KeyboardPress":
            guard let name=request["keyName"] as? String else {try reject("needs_user_action")}
            guard let (code,flags)=keys[name.lowercased()],let down=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:true),let up=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:false) else {try reject("needs_user_action")}
            var modifierDown:CGEvent?,modifierUp:CGEvent?
            if flags.contains(.maskCommand) {
                modifierDown=CGEvent(keyboardEventSource:source,virtualKey:55,keyDown:true)
                modifierUp=CGEvent(keyboardEventSource:source,virtualKey:55,keyDown:false)
                modifierDown?.flags=flags;modifierUp?.flags=[]
            }
            try fresh()
            if code==0 && flags == .maskCommand, try editNative(binding,nil,selectAll:true) {try fresh();return ["posted":true,"delivery":"accessibility"]}
            _=try receiver(binding)
            try focusRecord(binding.pid,binding.windowID,true)
            down.flags=flags;up.flags=[];try fresh()
            if let event=modifierDown {send(event);usleep(1000)}
            send(down);usleep(10000);send(up)
            if let event=modifierUp {send(event)}
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
