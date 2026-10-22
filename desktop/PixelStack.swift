import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var navigationReady = false
    private var isQuitting = false
    private var nativeAudio: NativePixelAudio!

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()

        nativeAudio = NativePixelAudio(soundDirectory: Bundle.main.resourceURL?.appendingPathComponent("sounds", isDirectory: true), initiallyEnabled: false)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(self, name: "pixelAudio")
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.PixelNativeAudio = \(nativeAudio.isReady ? "true" : "false");",
            injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: configuration)
        nativeAudio.onAvailabilityChange = { [weak self] available in
            self?.syncNativeAudioAvailability(available)
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Tetris"
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 720, height: 620)
        window.backgroundColor = NSColor(calibratedRed: 0.094, green: 0.106, blue: 0.137, alpha: 1)
        // Keep the normal window controls while letting the playfield reach both edges.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.collectionBehavior = .fullScreenPrimary
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("PixelStackMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        guard let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") else {
            let alert = NSAlert()
            alert.messageText = "游戏文件缺失"
            alert.informativeText = "请在项目目录重新运行 build-desktop.sh，完成后再打开 Tetris。"
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationDidBecomeActive(_ notification: Notification) {
        nativeAudio?.setApplicationActive(true)
    }

    func applicationDidResignActive(_ notification: Notification) {
        nativeAudio?.setApplicationActive(false)
        guard navigationReady, !isQuitting else { return }
        webView.evaluateJavaScript("window.PixelStack?.persistAndPause()", completionHandler: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !isQuitting else { return .terminateLater }
        guard navigationReady, webView != nil else { return .terminateNow }
        isQuitting = true
        nativeAudio?.setApplicationActive(false)
        persistAndPause {
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationReady = true
        // The document-start flag was captured at launch. Refresh its status
        // after reloads so a later hardware failure cannot leave a stale true.
        syncNativeAudioAvailability(nativeAudio.isReady)
        window.makeFirstResponder(webView)
    }

    private func syncNativeAudioAvailability(_ available: Bool) {
        let script = available ? "window.PixelNativeAudio = true;" :
            "window.PixelNativeAudio = false; window.dispatchEvent(new Event('pixelAudioUnavailable'));"
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !isQuitting, message.name == "pixelAudio", message.frameInfo.isMainFrame,
              let frameURL = message.frameInfo.request.url, frameURL.isFileURL,
              let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true) else { return }
        let rootPath = webRoot.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        let framePath = frameURL.standardizedFileURL.resolvingSymlinksInPath().path
        guard framePath.hasPrefix(rootPath) else { return }
        nativeAudio.handle(message.body)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.isFileURL || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            decisionHandler(.allow)
        } else {
            if navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "导出 Tetris 备份"
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.url : nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "选择 Tetris 备份"
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Tetris"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Tetris"
        alert.informativeText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    private func persistAndPause(completion: @escaping () -> Void) {
        var finished = false
        let finish: () -> Void = {
            guard !finished else { return }
            finished = true
            // Allow WebKit's backing store to flush after localStorage is updated.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: completion)
        }
        webView.callAsyncJavaScript(
            "const game = window.PixelStack; if (game && typeof game.persistAndPause === 'function') { await game.persistAndPause(); } return true;",
            arguments: [:], in: nil, in: .page
        ) { _ in finish() }
        // An unresponsive web process must never prevent the user from quitting.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: finish)
    }

    @objc private func reloadGame() {
        guard !isQuitting else { return }
        persistAndPause { [weak self] in
            self?.navigationReady = false
            self?.webView.reload()
        }
    }

    @objc private func undoPlacement() {
        guard navigationReady, !isQuitting else { return }
        webView.evaluateJavaScript("""
            (() => {
                const element = document.activeElement;
                if (element && (element.matches('input,textarea') || element.isContentEditable)) {
                    document.execCommand('undo');
                } else {
                    window.PixelStack?.undo();
                }
            })();
            """, completionHandler: nil)
    }

    @objc private func openGameSettings() {
        guard navigationReady, !isQuitting else { return }
        webView.evaluateJavaScript("window.PixelStack?.openSettings()", completionHandler: nil)
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Tetris",
            .applicationVersion: "1.11",
            .credits: NSAttributedString(string: "轻量、离线、随时来一把。\n游戏数据保存在这台 Mac 上。")
        ])
    }

    private func installMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu(title: "Tetris")
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 Tetris", action: #selector(showAbout), keyEquivalent: "").target = self
        appMenu.addItem(withTitle: "游戏设置…", action: #selector(openGameSettings), keyEquivalent: ",").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Tetris", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Tetris", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let fileMenu = NSMenu(title: "游戏")
        fileItem.submenu = fileMenu
        fileMenu.addItem(withTitle: "保存并刷新", action: #selector(reloadGame), keyEquivalent: "r").target = self
        fileMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: #selector(undoPlacement), keyEquivalent: "z").target = self
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = main
    }
}

@main
enum PixelStackMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
