import ColorSync
import AppKit
import ApplicationServices
import ScreenCaptureKit

private enum DriverFailure: Error {
    case unavailable
    case selection
    case changed
}

private func attribute(_ source: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(source, name as CFString, &value) == .success ? value : nil
}

private func geometry(_ window: AXUIElement) -> CGRect? {
    guard let location = attribute(window, kAXPositionAttribute),
          let dimensions = attribute(window, kAXSizeAttribute),
          CFGetTypeID(location) == AXValueGetTypeID(), CFGetTypeID(dimensions) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(location as! AXValue, .cgPoint, &point),
          AXValueGetValue(dimensions as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

@available(macOS 15.2, *)
private final class Driver: NSObject, SCContentSharingPickerObserver {
    private var filter: SCContentFilter?
    private var selected: SCWindow?
    private var pending: String?
    private var elements: [String: AXUIElement] = [:]
    private var surface: CGRect?
    private var sharedDisplay: CGDirectDisplayID?
    private var preparedApp: (token: String, display: CGDirectDisplayID, target: InstalledApp)?

    private struct InstalledApp {
        let url: URL
        let bundleID: String
        let fileID: NSObject
    }

    func reply(_ id: String, _ fields: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: fields.merging(["id": id]) { first, _ in first }) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    func receive(_ line: String) {
        guard line.utf8.count < 20_000,
              let data = line.data(using: .utf8),
              let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = input["id"] as? String, let operation = input["operation"] as? String else { return }
        switch operation {
        case "pick":
            guard pending == nil else { reply(id, ["error": "A native selection is open."]); return }
            pending = id
            let picker = SCContentSharingPicker.shared
            var configuration = SCContentSharingPickerConfiguration()
            configuration.allowedPickerModes = [.singleWindow]
            configuration.allowsChangingSelectedContent = false
            picker.configuration = configuration
            picker.add(self)
            picker.isActive = true
            picker.present()
        case "accessibility":
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            reply(id, ["trusted": AXIsProcessTrustedWithOptions(options)])
        case "screen_probe":
            guard let display = input["displayId"] as? UInt32, screenBounds(display, input) != nil,
                  let key = screenKey(display) else {
                reply(id, ["error": "The selected display is unavailable or mirrored."])
                return
            }
            sharedDisplay = display
            if input["requestPointerPermission"] as? Bool == true && !CGPreflightPostEventAccess() {
                _ = CGRequestPostEventAccess()
            }
            reply(id, ["approved": true, "displayKey": key, "accessibility": CGPreflightPostEventAccess(), "applicationLaunch": true])
        case "screen_pointer":
            pointer(id, input)
        case "resolve_application":
            preparedApp = nil
            guard let display = approvedScreen(input), let name = input["application"] as? String,
                  name.utf16.count <= 120,
                  name.range(of: #"\A[\p{L}\p{N}][\p{L}\p{M}\p{N} ._&+()'’\-]*\z"#, options: .regularExpression) != nil else {
                reply(id, ["error": "Select a current display and supply an installed macOS app name or bundle identifier."])
                return
            }
            guard let target = resolveApplication(name) else {
                reply(id, ["error": "macOS could not identify one installed app with that name. Check Applications or use its bundle identifier."])
                return
            }
            let token = UUID().uuidString
            preparedApp = (token, display, target)
            reply(id, ["application": ["token": token, "path": target.url.path, "bundleId": target.bundleID]])
        case "open_application":
            let prepared = preparedApp
            preparedApp = nil
            guard let display = approvedScreen(input), let prepared, prepared.display == display,
                  prepared.token == input["token"] as? String,
                  let current = installedApp(prepared.target.url),
                  current.url.path == prepared.target.url.path, current.bundleID == prepared.target.bundleID,
                  current.fileID.isEqual(prepared.target.fileID) else {
                reply(id, ["error": "The selected app or display changed before launch. Resolve the app again."])
                return
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: current.url, configuration: configuration) { app, error in
                let verified = error == nil && app?.bundleIdentifier == current.bundleID &&
                    app?.bundleURL?.resolvingSymlinksInPath().path == current.url.path && app?.isTerminated == false
                self.reply(id, ["submitted": true, "verified": verified])
            }
        case "observe", "set_value":
            Task { @MainActor in
                do {
                    if operation == "observe" { reply(id, try await observe(image: input["image"] as? Bool ?? false)) }
                    else { try setValue(input); reply(id, ["submitted": true]) }
                } catch {
                    reply(id, ["error": "The selected TextEdit window or its system permissions changed."])
                }
            }
        default:
            reply(id, ["error": "Unsupported local desktop operation."])
        }
    }

    private func approvedScreen(_ input: [String: Any]) -> CGDirectDisplayID? {
        guard let display = sharedDisplay, screenBounds(display, input) != nil,
              let key = screenKey(display), key == input["displayKey"] as? String else { return nil }
        return display
    }

    private var applicationFolders: [URL] {
        [FileManager.SearchPathDomainMask.systemDomainMask, .localDomainMask, .userDomainMask]
            .flatMap { FileManager.default.urls(for: .applicationDirectory, in: $0) }
            .flatMap { [$0, $0.appendingPathComponent("Utilities", isDirectory: true)] }
            .map { $0.resolvingSymlinksInPath() }
    }

    private func installedApp(_ candidate: URL) -> InstalledApp? {
        let url = candidate.resolvingSymlinksInPath()
        guard url.pathExtension.lowercased() == "app",
              applicationFolders.contains(where: { $0.path == url.deletingLastPathComponent().path }),
              let bundle = Bundle(url: url), let bundleID = bundle.bundleIdentifier,
              bundle.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "APPL",
              let fileID = (try? url.resourceValues(forKeys: [.fileResourceIdentifierKey]))?.fileResourceIdentifier as? NSObject
        else { return nil }
        return InstalledApp(url: url, bundleID: bundleID, fileID: fileID)
    }

    private func resolveApplication(_ name: String) -> InstalledApp? {
        // Preserve the existing selector for the system Messages app.
        if name == "messages" {
            let url = URL(fileURLWithPath: "/System/Applications/Messages.app", isDirectory: true)
            guard let target = installedApp(url), target.bundleID == "com.apple.MobileSMS" else { return nil }
            return target
        }
        if name.contains("."), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name),
           let target = installedApp(url), target.bundleID == name {
            return target
        }
        let basename = name.lowercased().hasSuffix(".app") ? String(name.dropLast(4)) : name
        let matches = applicationFolders.flatMap { folder in
            (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
        }.filter {
            $0.pathExtension.lowercased() == "app" &&
                $0.deletingPathExtension().lastPathComponent.caseInsensitiveCompare(basename) == .orderedSame
        }.compactMap(installedApp)
        guard let match = matches.first, matches.allSatisfy({ $0.url.path == match.url.path }) else { return nil }
        return match
    }

    private func screenBounds(_ display: CGDirectDisplayID, _ input: [String: Any]) -> CGRect? {
        guard CGDisplayIsActive(display) != 0, CGDisplayIsInMirrorSet(display) == 0,
              let expected = input["bounds"] as? [String: Double] else { return nil }
        let bounds = CGDisplayBounds(display)
        guard bounds.width > 0, bounds.height > 0,
              [("x", bounds.minX), ("y", bounds.minY), ("width", bounds.width), ("height", bounds.height)]
                .allSatisfy({ key, actual in expected[key].map { abs($0 - actual) < 1 } ?? false }) else { return nil }
        return bounds
    }

    private func screenKey(_ display: CGDirectDisplayID) -> String? {
        guard let uuid = CGDisplayCreateUUIDFromDisplayID(display)?.takeRetainedValue(),
              let value = CFUUIDCreateString(nil, uuid) else { return nil }
        return value as String
    }

    private func pointer(_ id: String, _ input: [String: Any]) {
        guard CGPreflightPostEventAccess() else {
            reply(id, ["error": "Allow the Aria native helper in macOS Accessibility, then check permissions again."])
            return
        }
        guard let display = sharedDisplay, let bounds = screenBounds(display, input),
              let key = screenKey(display), key == input["displayKey"] as? String,
              let action = input["action"] as? String else {
            reply(id, ["error": "The selected display changed. Observe it again."])
            return
        }
        let modifiers: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]
        guard CGEventSource.flagsState(.combinedSessionState).intersection(modifiers).isEmpty,
              ![CGMouseButton.left, .right, .center].contains(where: { CGEventSource.buttonState(.combinedSessionState, button: $0) }) else {
            reply(id, ["error": "Release any mouse buttons or modifier keys and retry."])
            return
        }
        let positions = action == "drag" ? input["path"] as? [[String: Any]] ?? [] : [input]
        let points = positions.compactMap { position -> CGPoint? in
            guard let x = position["x"] as? Double, let y = position["y"] as? Double,
                  (0..<1).contains(x), (0..<1).contains(y) else { return nil }
            let point = CGPoint(x: bounds.minX + bounds.width * x, y: bounds.minY + bounds.height * y)
            return bounds.contains(point) ? point : nil
        }
        guard points.count == positions.count, let first = points.first,
              let events = mouseEvents(action, input, points) else {
            reply(id, ["error": "The native mouse action could not be prepared."])
            return
        }
        for event in events {
            event.flags = []
            event.post(tap: .cghidEventTap)
        }
        if action == "move" {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(80)) {
                let position = CGEvent(source: nil)?.location
                let verified = position.map { abs($0.x - first.x) <= 2 && abs($0.y - first.y) <= 2 } ?? false
                self.reply(id, ["submitted": true, "verified": verified])
            }
        } else {
            reply(id, ["submitted": true])
        }
    }

    private func mouseEvents(_ action: String, _ input: [String: Any], _ points: [CGPoint]) -> [CGEvent]? {
        guard let first = points.first,
              let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                 mouseCursorPosition: first, mouseButton: .left) else { return nil }
        var events = [move]
        switch action {
        case "move":
            break
        case "click", "double_click":
            let buttons: [String: (CGMouseButton, CGEventType, CGEventType)] = [
                "left": (.left, .leftMouseDown, .leftMouseUp),
                "right": (.right, .rightMouseDown, .rightMouseUp),
                "middle": (.center, .otherMouseDown, .otherMouseUp),
            ]
            let name = action == "double_click" ? "left" : input["button"] as? String ?? ""
            guard let (button, down, up) = buttons[name] else { return nil }
            for count in 1...(action == "double_click" ? 2 : 1) {
                for type in [down, up] {
                    guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                                              mouseCursorPosition: first, mouseButton: button) else { return nil }
                    event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
                    events.append(event)
                }
            }
        case "drag":
            guard (2...32).contains(points.count),
                  let last = points.last,
                  let press = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                      mouseCursorPosition: first, mouseButton: .left),
                  let release = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                                        mouseCursorPosition: last, mouseButton: .left) else { return nil }
            events.append(press)
            for point in points.dropFirst() {
                guard let drag = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged,
                                         mouseCursorPosition: point, mouseButton: .left) else { return nil }
                events.append(drag)
            }
            events.append(release)
        case "scroll":
            guard let x = input["scrollX"] as? Int32, let y = input["scrollY"] as? Int32,
                  (-1500...1500).contains(x), (-1500...1500).contains(y),
                  let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                      wheelCount: 2, wheel1: -y, wheel2: -x, wheel3: 0) else { return nil }
            wheel.location = first
            events.append(wheel)
        default:
            return nil
        }
        return events
    }

    private func finishSelection(_ filter: SCContentFilter?) {
        guard let id = pending else { return }
        pending = nil
        let picker = SCContentSharingPicker.shared
        picker.remove(self)
        picker.isActive = false
        guard let filter, filter.includedWindows.count == 1, let window = filter.includedWindows.first,
              window.owningApplication?.bundleIdentifier == "com.apple.TextEdit",
              let app = window.owningApplication,
              NSRunningApplication(processIdentifier: app.processID)?.bundleURL?.path == "/System/Applications/TextEdit.app" else {
            reply(id, ["error": "Select one window from the system TextEdit application."])
            return
        }
        selected = window
        self.filter = filter
        reply(id, ["approved": true, "accessibility": AXIsProcessTrusted()])
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        DispatchQueue.main.async { self.finishSelection(nil) }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        DispatchQueue.main.async { self.finishSelection(filter) }
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        DispatchQueue.main.async { self.finishSelection(nil) }
    }

    private func current() throws -> (SCContentFilter, SCWindow, CGRect) {
        guard let filter, let selected, let app = selected.owningApplication,
              NSRunningApplication(processIdentifier: app.processID)?.bundleURL?.path == "/System/Applications/TextEdit.app",
              let windows = CGWindowListCopyWindowInfo([.optionIncludingWindow], selected.windowID) as? [[String: Any]],
              let info = windows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == selected.windowID }),
              (info[kCGWindowOwnerPID as String] as? Int32) == app.processID,
              (info[kCGWindowIsOnscreen as String] as? Bool) == true,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rectangle = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              rectangle.width > 1, rectangle.height > 1 else { throw DriverFailure.changed }
        return (filter, selected, rectangle)
    }

    private func editor(_ selected: SCWindow, _ bounding: CGRect) -> AXUIElement? {
        guard AXIsProcessTrusted(), let app = selected.owningApplication else { return nil }
        let accessibility = AXUIElementCreateApplication(app.processID)
        AXUIElementSetMessagingTimeout(accessibility, 1.0)
        let windows = attribute(accessibility, kAXWindowsAttribute) as? [AXUIElement] ?? []
        let matches = windows.filter { window in
            guard let location = geometry(window) else { return false }
            return abs(location.minX - bounding.minX) < 2 && abs(location.minY - bounding.minY) < 2 &&
                abs(location.width - bounding.width) < 2 && abs(location.height - bounding.height) < 2
        }
        guard matches.count == 1, let target = matches.first,
              let focused = attribute(accessibility, kAXFocusedWindowAttribute), CFEqual(target, focused),
              !((attribute(target, kAXChildrenAttribute) as? [AXUIElement]) ?? []).contains(where: {
                (attribute($0, kAXRoleAttribute) as? String) == kAXSheetRole
              }) else { return nil }
        var queue = [target]
        var seen = 0
        var editors: [AXUIElement] = []
        while let element = queue.popLast(), seen < 96 {
            seen += 1
            let role = attribute(element, kAXRoleAttribute) as? String
            if role == kAXTextAreaRole {
                var writable: DarwinBoolean = false
                if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success && writable.boolValue {
                    editors.append(element)
                }
            } else if role != kAXSheetRole {
                queue.append(contentsOf: (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(24))
            }
        }
        return editors.count == 1 ? editors.first : nil
    }

    private func observe(image: Bool) async throws -> [String: Any] {
        let (filter, window, bounds) = try current()
        let scale = Double(filter.pointPixelScale)
        let dimensions = ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height, "scale": scale]
        var result: [String: Any] = ["surface": dimensions, "title": "TextEdit", "editable": false]
        surface = bounds
        if let editor = editor(window, bounds) {
            if let previous = elements.first, CFEqual(previous.value, editor) {
                result["elementId"] = previous.key
            } else {
                let id = UUID().uuidString.lowercased()
                elements = [id: editor]
                result["elementId"] = id
            }
            result["editable"] = true
        } else {
            elements.removeAll()
        }
        if image {
            let resize = min(1.0, 1024 / max(bounds.width, bounds.height))
            let configuration = SCStreamConfiguration()
            configuration.width = Int(bounds.width * resize)
            configuration.height = Int(bounds.height * resize)
            configuration.showsCursor = false
            configuration.capturesAudio = false
            configuration.ignoreShadowsSingleWindow = true
            let capture = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let (_, _, updated) = try current()
            guard updated == bounds,
                  let png = NSBitmapImageRep(cgImage: capture).representation(using: .png, properties: [:]),
                  png.count <= 1024 * 1024 else { throw DriverFailure.changed }
            result["image"] = png.base64EncodedString()
            result["imageWidth"] = capture.width
            result["imageHeight"] = capture.height
        }
        return result
    }

    private func setValue(_ input: [String: Any]) throws {
        let (_, window, bounds) = try current()
        guard bounds == surface, let reference = input["elementId"] as? String,
              let previous = elements[reference], let text = input["text"] as? String, text.utf16.count <= 4000,
              let editor = editor(window, bounds), CFEqual(previous, editor) else { throw DriverFailure.changed }
        guard AXUIElementSetAttributeValue(editor, kAXValueAttribute as CFString, text as CFString) == .success else {
            throw DriverFailure.unavailable
        }
    }
}

if #available(macOS 15.2, *) {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let driver = Driver()
    DispatchQueue.global().async {
        while let line = readLine() {
            DispatchQueue.main.async { driver.receive(line) }
        }
        DispatchQueue.main.async { application.terminate(nil) }
    }
    application.run()
} else {
    exit(2)
}
