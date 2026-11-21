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
