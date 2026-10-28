import AppKit
import QuartzCore
import UserNotifications

/// Native AppKit companion controller. Implements the full BigFish feature set
/// on Apple's official APIs:
/// - Borderless transparent NSPanel, `fullScreenAuxiliary` + `canJoinAllSpaces`
///   + `.floating` level, re-asserted every 2 s so the pet stays above
///   full-screen apps.
/// - Faithful port of the Qt helper's status card, multi-task card, animation
///   model, drag/click interactions, right-click menu,
///   idle micro-animations and layout persistence.
/// - Apple official permission handling (UserNotifications + Accessibility).
final class PetController: NSObject {
    static let labels: [String: String] = [
        "IDLE": "休息中",
        "THINKING": "思考中",
        "WORKING": "干活中",
        "WAITING": "等你呢",
        "SUCCESS": "完成啦",
        "ERROR": "出问题了",
        "DISCONNECTED": "已断开",
    ]

    static let statusColors: [String: (bg: String, fg: String)] = [
        "SUCCESS": ("#D9F7E4", "#12B85A"),
        "ERROR": ("#FDE3E3", "#E5484D"),
        "WAITING": ("#FFF0CE", "#D88A00"),
        "THINKING": ("#E2ECFF", "#4C78E8"),
        "WORKING": ("#DDEBFF", "#3478F6"),
        "DISCONNECTED": ("#ECEEF1", "#7B818A"),
    ]

    static let persistentStates: Set<String> = ["THINKING", "WORKING", "WAITING", "ERROR"]

    let model: AnimationModel
    let manifest: [String: Any]
    let assetRoot: URL
    let layoutURL: URL
    var webuiURL: String
    var openLabel = ProcessInfo.processInfo.environment["DAFEIYU_OPEN_LABEL"] ?? "打开 DSH"
    var balanceSummary = ""
    var providers: [(id: String, label: String)] = []
    var provider = ""
    var whisperLevel = ""
    var characters: [(id: String, name: String)] = []
    var character = ""
    static let annoyedLine = "别戳啦！再戳我就生气了！"
    /// Fallback right-click "动作" menu for manifests without "actionMenu".
    static let actionMenu: [(label: String, clip: String, line: String)] = [
        ("摸摸头", "head_pat", "好啦好啦，知道你喜欢我~"),
        ("戳一戳", "poke", "戳我干嘛，任务还在跑呢"),
        ("摸尾巴", "tail", "尾巴不是进度条啦！"),
        ("吃 Token", "eat_token", "Token 真好吃~"),
        ("伸懒腰", "idle_stretch", "伸个懒腰，舒服~"),
        ("打哈欠", "idle_yawn", "啊——有点困了"),
        ("庆祝一下", "success", "耶！"),
    ]
    static let whisperMenu: [(label: String, level: String)] = [
        ("关闭", "off"), ("偶尔说（15～30 分钟）", "low"), ("话多（5～10 分钟）", "high"),
    ]
    let eventLogURL: URL?
    let snapshotURL: URL?

    private var frameData: [String: Data] = [:]
    private let imageCache = NSCache<NSString, NSImage>()
    /// Decoded frames are held only in this bounded cache: a 24 fps set is
    /// thousands of frames and each decoded one costs about 0.55 MB.
    private static let decodedFrameCache = 24
    private var maxFrameWidth: CGFloat = 238
    private var maxFrameHeight: CGFloat = 260
    /// Clips with wide props are drawn centred on the pet and may be wider
    /// than the pet's own frame; the window leaves room for the widest.
    private var maxClipWidth: CGFloat = 238

    private(set) var panel: NSPanel?
    private(set) var contentView: PetView?

    var scale: Double
    var bubbleScale: Double
    var reducedMotion: Bool
    var activityLevel: String
    var soundEnabled: Bool
    var bubbleMode: String
    var bubbleStates: [String]

    // Durable status
    var displayState = "IDLE"
    var statusState = "IDLE"
    var statusMessage = "我在这儿等新任务哦"
    var statusDetail = "DSH · 等待下一次任务"
    var statusDeadlineMs: Int?
    var overlayState: String?
    var overlayMessage = ""
    var overlayDetail = ""
    var overlayDeadlineMs: Int?
    var task = ""
    var tasks: [[String: Any]] = []

    // Geometry (pet anchor in AppKit bottom-left coordinates)
    private var petX: CGFloat = 0
    private var petY: CGFloat = 0

    private(set) var dragging = false

    private var animTimer: Timer?
    private var keepFrontTimer: Timer?
    private var microTimer: Timer?
    private var clickThroughTimer: Timer?
    /// A native menu runs its own tracking loop; keep the panel interactive
    /// until it closes so the timer cannot steal the selection click.
    private var menuOpen = false
    private var lastTickMs: Int
    private var dragPetOffsetX: CGFloat = 0
    private var dragPetOffsetY: CGFloat = 8
    private var fadeFromFrame: String?
    private var fadeStarted: CFTimeInterval = 0
    private var fadeDuration: Double = 0.15
    private var snapshotSaved = false
    private var quitting = false

    init(model: AnimationModel,
         manifest: [String: Any],
         assetRoot: URL,
         layoutURL: URL,
         webuiURL: String,
         eventLogURL: URL?,
         snapshotURL: URL?) {
        self.model = model
        self.manifest = manifest
        self.assetRoot = assetRoot
        self.layoutURL = layoutURL
        self.webuiURL = webuiURL
        self.eventLogURL = eventLogURL
        self.snapshotURL = snapshotURL

        let env = ProcessInfo.processInfo.environment
        let layout = PetLayout.load(from: layoutURL)
        if let raw = env["DAFEIYU_SCALE"], let value = Double(raw) {
            self.scale = Self.clampedScale(value)
        } else {
            self.scale = Self.clampedScale(layout.scale)
        }
        if let raw = env["DAFEIYU_BUBBLE_SCALE"], let value = Double(raw) {
            self.bubbleScale = Self.clampedBubbleScale(value)
        } else {
            self.bubbleScale = Self.clampedBubbleScale(layout.bubbleScale)
        }
        if let raw = env["DAFEIYU_REDUCED_MOTION"] {
            self.reducedMotion = raw == "1"
        } else {
            self.reducedMotion = layout.reducedMotion
        }
        self.activityLevel = env["DAFEIYU_ACTIVITY_LEVEL"] ?? "normal"
        self.soundEnabled = env["DAFEIYU_SOUND_ENABLED"] != "0"
        let configuredBubbleMode = env["DAFEIYU_BUBBLE_MODE"]
        self.bubbleMode = ["auto", "always", "hidden", "custom"].contains(configuredBubbleMode ?? "")
            ? configuredBubbleMode!
            : layout.bubbleMode
        self.bubbleStates = env["DAFEIYU_BUBBLE_STATES"]
            .map { $0.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) } }
            ?? layout.bubbleStates
        self.lastTickMs = Self.nowMs()
        super.init()

        if let mfw = manifest["maxFrameWidth"] as? Int { maxFrameWidth = CGFloat(mfw) }
        if let mfh = manifest["maxFrameHeight"] as? Int { maxFrameHeight = CGFloat(mfh) }
        maxClipWidth = CGFloat(manifest["maxClipWidth"] as? Int ?? Int(maxFrameWidth))
        pixelScale = CGFloat(Self.doubleValue(manifest["pixelScale"]) ?? 1)
        bubbleHeadroom = CGFloat(Self.doubleValue(manifest["bubbleHeadroom"]) ?? 52)
        loadFrames()
        if !isHeadless() {
            buildWindow()
            restorePosition()
            startTimers()
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(screenParametersChanged),
                name: NSApplication.didChangeScreenParametersNotification,
                object: nil
            )
        }
    }

    private func isHeadless() -> Bool {
        ProcessInfo.processInfo.arguments.contains("--headless")
    }

    // MARK: - Frames & geometry

    /// Sprite-sheet characters (codex-pets packs) name frames
    /// "cell:<column>:<row>:..." and are cropped from one sheet.
    private var sheetImage: CGImage?
    private var sheetCell = CGSize.zero
    /// Drawn size per frame pixel: 2 for small codex cells, 1 for the whale.
    private var pixelScale: CGFloat = 1
    /// Transparent space above the head inside a frame, in frame pixels.
    private var bubbleHeadroom: CGFloat = 52

    private func loadFrames() {
        if let sheet = manifest["spritesheet"] as? [String: Any], let file = sheet["file"] as? String {
            sheetCell = CGSize(width: Self.doubleValue(sheet["cellWidth"]) ?? 0, height: Self.doubleValue(sheet["cellHeight"]) ?? 0)
            if let data = try? Data(contentsOf: assetRoot.appendingPathComponent(file)),
               let image = NSImage(data: data) {
                sheetImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
            }
            imageCache.totalCostLimit = Self.decodedFrameCache * decodedFrameBytes
            return
        }
        for clip in model.clips.values {
            for frame in clip.frames where frameData[frame] == nil {
                frameData[frame] = try? Data(contentsOf: assetRoot.appendingPathComponent(frame))
            }
        }
        imageCache.totalCostLimit = Self.decodedFrameCache * decodedFrameBytes
    }

    private var decodedFrameBytes: Int { Int(maxFrameWidth * maxFrameHeight * 4) }

    private func frameImage(for frame: String) -> NSImage? {
        let key = frame as NSString
        if let cached = imageCache.object(forKey: key) { return cached }
        if let sheet = sheetImage {
            let parts = frame.split(separator: ":")
            guard parts.count >= 3, let column = Double(parts[1]), let row = Double(parts[2]),
                  let cell = sheet.cropping(to: CGRect(x: column * sheetCell.width, y: row * sheetCell.height,
                                                        width: sheetCell.width, height: sheetCell.height)) else { return nil }
            let image = NSImage(cgImage: cell, size: sheetCell)
            imageCache.setObject(image, forKey: key, cost: decodedFrameBytes)
            return image
        }
        guard let data = frameData[frame], let image = NSImage(data: data) else { return nil }
        imageCache.setObject(image, forKey: key, cost: decodedFrameBytes)
        return image
    }

    private var petWidth: CGFloat { maxFrameWidth * scale * pixelScale }
    private var petHeight: CGFloat { maxFrameHeight * scale * pixelScale }

    // MARK: - Speech bubble (dsh-pet style)

    private static let bubbleFill = hex("#F4F4F6").withAlphaComponent(0.97)
    private static let bubbleShadow = NSColor.black.withAlphaComponent(0.22)
    private static let bubbleText = hex("#26262B")
    private static let bubbleSubtext = hex("#7A7A84")
    private static let bubbleTail = (width: CGFloat(18), height: CGFloat(10))
    /// The top of every frame is transparent headroom above the character's
    /// head; the bubble overlaps it so the tail reaches the head.

    private var footerHeight: CGFloat { balanceSummary.isEmpty ? 0 : 20 * bubbleScale }

    /// Window room reserved for the bubble: the tallest it can get plus its tail.
    private var cardHeightPoints: CGFloat {
        let s = bubbleScale
        if tasks.count >= 2 {
            return (40 + CGFloat(taskRowCount) * 22 + Self.bubbleTail.height) * s + footerHeight
        }
        return (64 + Self.bubbleTail.height) * s + footerHeight
    }

    private var taskRowCount: Int { min(tasks.count, 3) + (tasks.count > 3 ? 1 : 0) }

    // Widest bubble; short lines shrink to fit their text.
    private var cardWidthPoints: CGFloat { 300 * bubbleScale }

    private var bubbleFontScale: CGFloat { min(1.2, max(1.0, bubbleScale)) }

    /// Rounded display font: 上首软糖体 when it is installed, else SF Rounded.
    private func bubbleFont(size: CGFloat, weight: NSFont.Weight) -> NSFont {
        for family in ["上首软糖体", "ShangShouRuanTangTi"] {
            if let font = NSFontManager.shared.font(withFamily: family, traits: [], weight: 5, size: size) {
                return font
            }
        }
        let base = NSFont.systemFont(ofSize: size, weight: weight)
        if let rounded = base.fontDescriptor.withDesign(.rounded), let font = NSFont(descriptor: rounded, size: size) {
            return font
        }
        return base
    }

    private var bubbleTitleFont: NSFont { bubbleFont(size: 14 * bubbleFontScale, weight: .bold) }
    private var bubbleDetailFont: NSFont { bubbleFont(size: 10 * bubbleFontScale, weight: .medium) }
    private var bubbleFooterFont: NSFont { bubbleFont(size: 9 * bubbleFontScale, weight: .medium) }

    private func textWidth(_ text: String, font: NSFont) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    /// Single-status content; nil while the multi-task list is shown.
    private func bubbleContent() -> (title: String, detail: String)? {
        if tasks.count >= 2 { return nil }
        if let card = currentCard() { return (card.title, card.detail) }
        if !balanceSummary.isEmpty && bubbleMode == "always" { return ("大肥鱼陪你待命", "") }
        return nil
    }

    private func bubbleSize() -> NSSize {
        let s = bubbleScale
        if tasks.count >= 2 {
            return NSSize(width: cardWidthPoints, height: (40 + CGFloat(taskRowCount) * 22) * s + footerHeight)
        }
        guard let content = bubbleContent() else { return .zero }
        let widest = max(
            textWidth(content.title, font: bubbleTitleFont),
            content.detail.isEmpty ? 0 : textWidth(content.detail, font: bubbleDetailFont),
            balanceSummary.isEmpty ? 0 : textWidth(balanceSummary, font: bubbleFooterFont)
        )
        let width = min(cardWidthPoints, max(110 * s, widest + 40 * s))
        let height = (content.detail.isEmpty ? 44 : 60) * s + footerHeight
        return NSSize(width: ceil(width), height: ceil(height))
    }

    private func windowSize() -> NSSize {
        // A hidden card must not keep the window as wide as a 420pt card:
        // at scale 0.55 that left roughly 385pt of mostly transparent window
        // around a ~219pt character (issue #92).
        let showsCard = bubbleMode != "hidden"
        let petArea = max(petWidth + 50, maxClipWidth * scale * pixelScale + 10)
        return NSSize(
            width: showsCard ? max(petArea, cardWidthPoints + 28) : petArea,
            height: petHeight + (showsCard ? cardHeightPoints + 34 : 26)
        )
    }

    func petRect() -> NSRect {
        let viewSize = contentView?.bounds.size ?? windowSize()
        let offsetX = min(max(petX - (panel?.frame.origin.x ?? 0), 0), viewSize.width - petWidth)
        return NSRect(x: offsetX, y: viewSize.height - petHeight - 8, width: petWidth, height: petHeight)
    }

    func bubbleRect() -> NSRect {
        let viewSize = contentView?.bounds.size ?? windowSize()
        let size = bubbleSize()
        let pet = petRect()
        let margin: CGFloat = 14
        let minX = margin
        let maxX = max(minX, viewSize.width - size.width - margin)
        let cardX = min(max(pet.midX - size.width / 2, minX), maxX)
        // Sit right above the head: the tail tip lands just inside the
        // frame's transparent headroom instead of floating far above it.
        let tailTip = pet.minY + bubbleHeadroom * scale * pixelScale
        let cardY = max(7, tailTip - Self.bubbleTail.height * bubbleScale - size.height)
        return NSRect(x: cardX, y: cardY, width: size.width, height: size.height)
    }

    private func screenContaining(_ point: NSPoint) -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(point) }
    }

    func moveToPet(_ x: CGFloat, _ y: CGFloat) {
        guard let panel = panel else { return }
        let size = windowSize()
        let geometry = screenContaining(NSPoint(x: x + petWidth / 2, y: y + petHeight / 2))?.visibleFrame
            ?? panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame
            ?? NSRect(origin: .zero, size: size)
        let position = PetGeometry.clamp(NSPoint(x: x, y: y), petSize: NSSize(width: petWidth, height: petHeight), screen: geometry)
        let minX = geometry.minX - (size.width - petWidth * 0.35)
        let maxX = geometry.maxX - petWidth * 0.35
        let centerOffsetX = (size.width - petWidth) / 2
        let windowX = min(max(position.x - centerOffsetX, minX), maxX)
        let offsetX = min(max(position.x - windowX, 0), size.width - petWidth)
        self.petX = windowX + offsetX

        let windowY = position.y - 8
        self.petY = windowY + 8

        panel.setFrameOrigin(NSPoint(x: windowX, y: windowY))
        updateClickThrough()
        contentView?.needsDisplay = true
    }

    private func restorePosition() {
        let layout = PetLayout.load(from: layoutURL)
        let screenHeight = NSScreen.main?.frame.height ?? 982
        if let px = layout.petX, let py = layout.petY {
            let ax = CGFloat(px)
            var ay = CGFloat(py)
            if layout.coordinateSpace == nil && ay < screenHeight * 0.5 {
                // Legacy Qt layout stores top-left coordinates; convert to
                // AppKit bottom-left before first use.
                ay = screenHeight - (ay + petHeight)
            }
            moveToPet(ax, ay)
        } else {
            let geometry = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1512, height: 982)
            moveToPet(geometry.maxX - petWidth - 24, geometry.minY + 24)
        }
        saveLayout()
    }

    func saveLayout() {
        guard let panel = panel else { return }
        let origin = panel.frame.origin
        var layout = PetLayout()
        layout.x = Int(origin.x.rounded())
        layout.y = Int(origin.y.rounded())
        layout.petX = Int(petX.rounded())
        layout.petY = Int(petY.rounded())
        layout.scale = scale
        layout.bubbleScale = bubbleScale
        layout.reducedMotion = reducedMotion
        layout.bubbleMode = bubbleMode
        layout.bubbleStates = bubbleStates
        layout.save(to: layoutURL)
    }

    func resizeAndReposition() {
        guard let panel = panel, let contentView = contentView else { return }
        let size = windowSize()
        let origin = panel.frame.origin
        panel.setContentSize(size)
        panel.setFrameOrigin(origin)
        contentView.frame = NSRect(origin: .zero, size: size)
        moveToPet(petX, petY)
        contentView.needsDisplay = true
    }

    // MARK: - Window

    private func buildWindow() {
        let size = windowSize()
        let panel = NSPanel(
            contentRect: NSRect(x: 100, y: 100, width: size.width, height: size.height),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = false
        panel.isMovableByWindowBackground = false
        panel.title = "大肥鱼"

        let view = PetView(frame: NSRect(x: 0, y: 0, width: size.width, height: size.height))
        view.controller = self
        panel.contentView = view
        self.panel = panel
        self.contentView = view
    }

    func show() {
        guard !isHeadless() else { return }
        panel?.orderFrontRegardless()
        keepFront()
        updateClickThrough()
    }

    @objc private func screenParametersChanged() {
        moveToPet(petX, petY)
    }

    // MARK: - Timers

    private var animationInterval: TimeInterval {
        if reducedMotion { return 0.04 }
        // Sub-frame poll: a once-per-frame timer turns one early delivery into a whole-frame hitch.
        return min(0.02, max(0.008, Double(model.activeClip.frameMs) / 3000))
    }

    private func startAnimTimer() {
        animTimer?.invalidate()
        animTimer = Timer.scheduledTimer(withTimeInterval: animationInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    private func startTimers() {
        startAnimTimer()
        keepFrontTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.keepFront()
        }
        // 30 Hz is enough to hand a click to the application below without
        // making the user wait; it only compares a point against two rects.
        clickThroughTimer = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in
            self?.updateClickThrough()
        }
        updateClickThrough()
        scheduleMicro()
    }

    /// AppKit routes a click to this panel before it ever reaches the view
    /// hierarchy, so `hitTest` alone cannot pass a click to the app below.
    /// Toggle `ignoresMouseEvents` instead, based on the real pointer position
    /// (issue #92). Drags and the context menu keep the panel interactive.
    private func updateClickThrough() {
        guard let panel = panel, let contentView = contentView else { return }
        guard !quitting, panel.isVisible, !dragging, !menuOpen else {
            setClickThrough(false)
            return
        }
        // Never flip the window between mouse-down and mouse-up: a click that
        // started on the app below must not lose its mouse-up to this panel.
        guard NSEvent.pressedMouseButtons == 0 else { return }
        let windowPoint = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let viewPoint = contentView.convert(windowPoint, from: nil)
        let bubble = bubbleVisible() ? bubbleRect() : nil
        setClickThrough(!PetGeometry.isInteractive(viewPoint, pet: petRect(), bubble: bubble))
    }

    private func setClickThrough(_ enabled: Bool) {
        guard let panel = panel, panel.ignoresMouseEvents != enabled else { return }
        panel.ignoresMouseEvents = enabled
    }

    private func keepFront() {
        guard let panel = panel, !quitting else { return }
        // Re-assert every 2 s: other apps or full-screen transitions can reset
        // the level/collection behavior, which would hide the pet.
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.orderFrontRegardless()
    }

    private func scheduleMicro() {
        microTimer?.invalidate()
        guard !reducedMotion else { return }
        let range = model.idleMicroInterval(activityLevel: activityLevel)
        let delay = Double(model.overlayRemainingMs + Int.random(in: range)) / 1000
        microTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            if !self.dragging {
                let previousFrame = self.model.frame
                let previousClip = self.model.activeClipName
                let index = Int.random(in: 0..<max(1, self.model.idleMicroClips.count))
                _ = self.model.playIdleMicro(index: index)
                self.syncFrameTransition(previousFrame: previousFrame, previousClip: previousClip)
                self.contentView?.needsDisplay = true
            }
            self.scheduleMicro()
        }
    }

    private func tick() {
        let now = Self.nowMs()
        let elapsed = max(0, now - lastTickMs)
        lastTickMs = now
        let hadPulse = model.pulseState != nil
        let previousFrame = model.frame
        let previousClip = model.activeClipName
        let modelElapsed = reducedMotion ? 0 : elapsed
        model.advance(elapsedMs: modelElapsed, nowMs: now)
        syncFrameTransition(previousFrame: previousFrame, previousClip: previousClip)
        if hadPulse && model.pulseState == nil {
            displayState = model.baseState
        }
        if let deadline = overlayDeadlineMs, now >= deadline {
            clearOverlay()
        }
        if animTimer?.timeInterval != animationInterval {
            startAnimTimer()
        }
        contentView?.needsDisplay = true
    }

    private func syncFrameTransition(previousFrame: String, previousClip: String) {
        let currentFrame = model.frame
        guard currentFrame != previousFrame else { return }
        guard previousClip != model.activeClipName else { return }
        if let duration = AnimationModel.crossfadeDuration(previousClip: previousClip, currentClip: model.activeClipName) {
            fadeFromFrame = previousFrame
            fadeStarted = CACurrentMediaTime()
            fadeDuration = duration
        } else {
            fadeFromFrame = nil
        }
    }

    // MARK: - Interaction

    func beginDrag() {
        guard !dragging else { return }
        dragging = true
        // The drag must keep receiving mouseDragged even when the pointer
        // leaves the character rectangle.
        setClickThrough(false)
        fadeFromFrame = nil
        // Remember where the pet sits inside the window when the drag starts.
        // During the drag the window moves directly; without re-anchoring the
        // pet it would slide inside the window at the same rate and stay
        // frozen on screen while the bubble moves — a visible desync.
        let rect = petRect()
        dragPetOffsetX = rect.minX
        dragPetOffsetY = rect.minY
        microTimer?.invalidate()
        // `dragging` is a dangling loop: keep it advancing while the pointer
        // moves the window, otherwise the pet sits on its first frame and looks
        // frozen. Reduced motion keeps the previous frozen behaviour.
        guard model.playOverlay("dragging") else {
            animTimer?.invalidate()
            contentView?.needsDisplay = true
            return
        }
        if reducedMotion || !model.activeClip.loop {
            animTimer?.invalidate()
        } else {
            restartAnimTimer()
        }
        contentView?.needsDisplay = true
    }

    func updateDrag() {
        guard let panel = panel else { return }
        let viewSize = contentView?.bounds.size ?? windowSize()
        // Re-anchor the pet to the window's current origin using the offsets
        // captured at drag start, so the character and the bubble move as one.
        petX = panel.frame.origin.x + dragPetOffsetX
        petY = panel.frame.origin.y + (viewSize.height - dragPetOffsetY - petHeight)
        contentView?.needsDisplay = true
    }

    func endDrag() {
        guard dragging else { return }
        let now = Self.nowMs()
        model.advance(elapsedMs: 0, nowMs: now)
        if reducedMotion || !model.playOverlay("dragging_release") { model.clearOverlay() }
        fadeFromFrame = nil
        dragging = false
        lastTickMs = now
        startAnimTimer()
        if !reducedMotion {
            scheduleMicro()
        }
        saveLayout()
        updateClickThrough()
        contentView?.needsDisplay = true
    }

    func handleClick(at point: NSPoint, clickCount: Int) {
        if clickCount >= 2 {
            playInteraction("head_pat", message: "好啦好啦，知道你喜欢我~")
            return
        }
        let rect = petRect()
        let relativeX = max(0, point.x - rect.minX)
        let relativeY = max(0, point.y - rect.minY)
        let (region, line): (String, String)
        if relativeY < rect.height * 0.45 {
            (region, line) = ("head_pat", "摸摸也不能让我少干活哦~")
        } else if relativeX > rect.width * 0.72 {
            (region, line) = ("tail", "尾巴不是进度条啦！")
        } else {
            (region, line) = ("poke", "戳我干嘛，任务还在跑呢")
        }
        let clip = model.pickInteraction(region, nowMs: Self.nowMs())
        playInteraction(clip, message: model.annoyedClips.contains(clip) ? Self.annoyedLine : line)
        contentView?.needsDisplay = true
    }

    private func playInteraction(_ clipName: String, message: String) {
        let previousFrame = model.frame
        let previousClip = model.activeClipName
        guard reducedMotion || model.playInteraction(clipName, nowMs: Self.nowMs()) else { return }
        syncFrameTransition(previousFrame: previousFrame, previousClip: previousClip)
        showOverlay(message, statusDetail, statusState, 1800)
        scheduleMicro()
        contentView?.needsDisplay = true
    }

    /// Show a fixed chatter line; ordinary lines wait for an idle pet.
    private func say(_ message: [String: Any]) {
        let text = String((message["message"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        guard !text.isEmpty, !dragging else { return }
        let urgent = message["urgent"] as? Bool == true
        let idle = model.baseState == "IDLE" && model.pulseState == nil
        guard urgent || idle else { return }
        if idle && !reducedMotion && model.overlayClipName == nil {
            if let clip = message["clip"] as? String, model.clips[clip] != nil {
                _ = model.playOverlay(clip)
            } else {
                _ = model.playIdleMicro(index: Int.random(in: 0..<max(1, model.idleMicroClips.count)))
            }
        }
        let ttl = max(1500, min(15000, (message["ttlMs"] as? Int) ?? 6000))
        showOverlay(text, statusDetail, model.baseState, ttl)
        resizeAndReposition()
        contentView?.needsDisplay = true
    }

    @objc private func playAction(_ sender: NSMenuItem) {
        guard let entry = sender.representedObject as? [String], entry.count == 2 else { return }
        let (clip, line) = (entry[0], entry[1])
        guard !dragging, model.pulseState == nil else { return }
        if model.interactionClips.contains(clip) {
            playInteraction(clip, message: line)
            return
        }
        let previousFrame = model.frame
        let previousClip = model.activeClipName
        guard reducedMotion || model.playOverlay(clip) else { return }
        syncFrameTransition(previousFrame: previousFrame, previousClip: previousClip)
        showOverlay(line, statusDetail, statusState, 2500)
        scheduleMicro()
        contentView?.needsDisplay = true
    }

    /// Right-click "动作" groups from the manifest, or the flat fallback.
    private func actionMenuGroups() -> [(label: String, items: [(label: String, clip: String, line: String)])] {
        let groups = (manifest["actionMenu"] as? [[String: Any]] ?? []).compactMap { group -> (label: String, items: [(label: String, clip: String, line: String)])? in
            let items = (group["items"] as? [[String]] ?? []).compactMap { item -> (label: String, clip: String, line: String)? in
                item.count == 3 ? (label: item[0], clip: item[1], line: item[2]) : nil
            }
            return items.isEmpty ? nil : (label: group["label"] as? String ?? "", items: items)
        }
        return groups.isEmpty ? [(label: "", items: Self.actionMenu)] : groups
    }

    @objc private func changeCharacter(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        reportSettings(["character": id])
    }

    @objc private func openSettings(_ sender: Any?) {
        reportSettings(["request": "settings"])
    }

    @objc private func requestWhisper(_ sender: Any?) {
        reportSettings(["request": "whisper"])
    }

    @objc private func changeWhisperLevel(_ sender: NSMenuItem) {
        guard let level = sender.representedObject as? String else { return }
        whisperLevel = level
        reportSettings(["whisperLevel": level])
    }

    func showMenu(with event: NSEvent) {
        guard let contentView = contentView else { return }
        let menu = NSMenu(title: "大肥鱼")

        let sizeMenu = NSMenu(title: "大小")
        for (label, value) in [("小", 0.6), ("中", 0.8), ("大", 1.0), ("特大", 1.25)] {
            let item = NSMenuItem(title: label, action: #selector(changeSize(_:)), keyEquivalent: "")
            item.target = self
            item.tag = Int(value * 100)
            item.state = abs(scale - value) < 0.05 ? .on : .off
            sizeMenu.addItem(item)
        }
        let sizeItem = NSMenuItem(title: "大小", action: nil, keyEquivalent: "")
        sizeItem.submenu = sizeMenu
        menu.addItem(sizeItem)

        let bubbleMenu = NSMenu(title: "气泡大小")
        for (label, value) in [("小", 0.8), ("标准", 1.0), ("大", 1.2)] {
            let item = NSMenuItem(title: label, action: #selector(changeBubbleScale(_:)), keyEquivalent: "")
            item.target = self
            item.tag = Int(value * 100)
            item.state = abs(bubbleScale - value) < 0.05 ? .on : .off
            bubbleMenu.addItem(item)
        }
        let bubbleItem = NSMenuItem(title: "气泡大小", action: nil, keyEquivalent: "")
        bubbleItem.submenu = bubbleMenu
        menu.addItem(bubbleItem)

        if providers.count > 1 {
            let providerMenu = NSMenu(title: "服务商")
            for entry in providers {
                let item = NSMenuItem(title: entry.label, action: #selector(changeProvider(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = entry.id
                item.state = entry.id == provider ? .on : .off
                providerMenu.addItem(item)
            }
            let providerItem = NSMenuItem(title: "服务商", action: nil, keyEquivalent: "")
            providerItem.submenu = providerMenu
            menu.addItem(providerItem)
        }

        let actionMenu = NSMenu(title: "动作")
        for group in actionMenuGroups() {
            let target: NSMenu
            if group.label.isEmpty {
                target = actionMenu
            } else {
                target = NSMenu(title: group.label)
                let groupItem = NSMenuItem(title: group.label, action: nil, keyEquivalent: "")
                groupItem.submenu = target
                actionMenu.addItem(groupItem)
            }
            for entry in group.items where model.clips[entry.clip] != nil {
                let item = NSMenuItem(title: entry.label, action: #selector(playAction(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = [entry.clip, entry.line]
                target.addItem(item)
            }
        }
        let actionItem = NSMenuItem(title: "动作", action: nil, keyEquivalent: "")
        actionItem.submenu = actionMenu
        menu.addItem(actionItem)

        if characters.count > 1 {
            let characterMenu = NSMenu(title: "形象")
            for entry in characters {
                let item = NSMenuItem(title: entry.name, action: #selector(changeCharacter(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = entry.id
                item.state = entry.id == character ? .on : .off
                characterMenu.addItem(item)
            }
            let characterItem = NSMenuItem(title: "形象", action: nil, keyEquivalent: "")
            characterItem.submenu = characterMenu
            menu.addItem(characterItem)
        }

        // Only the shared daemon answers chatter requests.
        if !whisperLevel.isEmpty {
            let sayItem = NSMenuItem(title: "说句话", action: #selector(requestWhisper(_:)), keyEquivalent: "")
            sayItem.target = self
            menu.addItem(sayItem)
            let whisperMenu = NSMenu(title: "碎碎念")
            for entry in Self.whisperMenu {
                let item = NSMenuItem(title: entry.label, action: #selector(changeWhisperLevel(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = entry.level
                item.state = entry.level == whisperLevel ? .on : .off
                whisperMenu.addItem(item)
            }
            let whisperItem = NSMenuItem(title: "碎碎念", action: nil, keyEquivalent: "")
            whisperItem.submenu = whisperMenu
            menu.addItem(whisperItem)
        }

        let reduced = NSMenuItem(title: "减少动态", action: #selector(toggleReducedMotion(_:)), keyEquivalent: "")
        reduced.target = self
        reduced.state = reducedMotion ? .on : .off
        menu.addItem(reduced)

        if !webuiURL.isEmpty && !openLabel.isEmpty {
            let openWeb = NSMenuItem(title: openLabel, action: #selector(openWebUI(_:)), keyEquivalent: "")
            openWeb.target = self
            menu.addItem(openWeb)
        }

        // Only the shared daemon serves the settings page.
        if !whisperLevel.isEmpty {
            let settingsItem = NSMenuItem(title: "设置…", action: #selector(openSettings(_:)), keyEquivalent: "")
            settingsItem.target = self
            menu.addItem(settingsItem)
        }

        let accessibility = NSMenuItem(title: "辅助功能权限…", action: #selector(accessibilityPermission(_:)), keyEquivalent: "")
        accessibility.target = self
        menu.addItem(accessibility)

        menu.addItem(.separator())

        let hide = NSMenuItem(title: "本次隐藏", action: #selector(hidePet(_:)), keyEquivalent: "")
        hide.target = self
        menu.addItem(hide)

        let quit = NSMenuItem(title: "本次关闭", action: #selector(quitFromMenu(_:)), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)

        menuOpen = true
        defer {
            menuOpen = false
            updateClickThrough()
        }
        NSMenu.popUpContextMenu(menu, with: event, for: contentView)
    }

    @objc private func changeSize(_ sender: NSMenuItem) {
        scale = Self.clampedScale(Double(sender.tag) / 100.0)
        resizeAndReposition()
        saveLayout()
        reportSettings(["scale": scale])
    }

    @objc private func changeBubbleScale(_ sender: NSMenuItem) {
        bubbleScale = Self.clampedBubbleScale(Double(sender.tag) / 100.0)
        resizeAndReposition()
        saveLayout()
        reportSettings(["bubbleScale": bubbleScale])
    }

    private func setReducedMotion(_ enabled: Bool) {
        reducedMotion = enabled
        restartAnimTimer()
        if enabled {
            microTimer?.invalidate()
            if !dragging { model.clearOverlay() }
            fadeFromFrame = nil
        } else {
            scheduleMicro()
        }
    }

    @objc private func toggleReducedMotion(_ sender: NSMenuItem) {
        setReducedMotion(sender.state == .off)
        saveLayout()
        reportSettings(["reducedMotion": reducedMotion])
        contentView?.needsDisplay = true
    }

    @objc private func changeProvider(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        provider = id
        reportSettings(["provider": id])
    }

    @objc private func openWebUI(_ sender: Any?) {
        if let url = URL(string: webuiURL), NSWorkspace.shared.open(url) {
            return
        }
        FileHandle.standardError.write(Data("Unable to open the configured DSH client\n".utf8))
        showOverlay("无法打开 DSH", "请确认 DSH 已安装、打开地址设置正确", "ERROR", 4000)
        contentView?.needsDisplay = true
    }

    @objc private func accessibilityPermission(_ sender: Any?) {
        Permissions.requestAccessibility()
    }

    @objc private func hidePet(_ sender: Any?) {
        panel?.orderOut(nil)
    }

    @objc private func quitFromMenu(_ sender: Any?) {
        quit(reason: "user")
    }

    // MARK: - Protocol

    func apply(_ message: [String: Any]) {
        logEvent(message)
        let previousFrame = model.frame
        let previousClip = model.activeClipName
        let previousState = model.baseState
        guard let kind = message["kind"] as? String else { return }
        switch kind {
        case "shutdown":
            quit(reason: "host")
        case "state":
            handleState(message)
        case "pulse":
            handlePulse(message)
        case "task":
            handleTask(message)
        case "tasks":
            tasks = (message["tasks"] as? [[String: Any]]) ?? []
            resizeAndReposition()
            contentView?.needsDisplay = true
        case "config":
            applyConfig(message)
        case "say":
            say(message)
        case "balance":
            balanceSummary = String((message["summary"] as? String ?? "").prefix(200))
            resizeAndReposition()
            contentView?.needsDisplay = true
        default:
            break
        }
        syncFrameTransition(previousFrame: previousFrame, previousClip: previousClip)
        if previousState != model.baseState { scheduleMicro() }
        maybeSaveSnapshot()
    }

    private func handleState(_ message: [String: Any]) {
        let state = Self.stringValue(message["state"]) ?? "IDLE"
        let activity = Self.stringValue(message["activity"])
        let previousBase = model.baseState
        displayState = state
        model.applyState(state, activity: activity)
        // A turn that ends waiting or failing deserves the same system alert
        // as a completion pulse; the pet may be hidden behind other windows.
        if state != previousBase && (state == "WAITING" || state == "ERROR") {
            notifyAlert(state, detail: Self.stringValue(message["detail"]))
        }
        displayState = model.pulseState ?? state
        if model.pulseState == nil { clearOverlay() }
        showStatus(
            Self.stringValue(message["message"]) ?? Self.labels[state] ?? state,
            Self.stringValue(message["detail"]) ?? "",
            state,
            Self.persistentStates.contains(state) ? nil : 4200
        )
        contentView?.needsDisplay = true
    }

    private func handlePulse(_ message: [String: Any]) {
        let state = Self.stringValue(message["state"]) ?? "IDLE"
        var ttl = max(250, Self.intValue(message["ttlMs"]) ?? 1800)
        let resumeState = Self.stringValue(message["resumeState"]) ?? model.baseState
        let resumeActivity = Self.stringValue(message["resumeActivity"])
        model.applyPulse(
            state: state,
            ttlMs: ttl,
            nowMs: Self.nowMs(),
            resumeState: resumeState,
            resumeActivity: resumeActivity,
            completeClip: !reducedMotion
        )
        ttl = max(250, (model.pulseDeadlineMs ?? Self.nowMs()) - Self.nowMs())
        showStatus(
            Self.stringValue(message["resumeMessage"]) ?? Self.labels[resumeState] ?? resumeState,
            Self.stringValue(message["resumeDetail"]) ?? "",
            resumeState,
            Self.persistentStates.contains(resumeState) ? nil : ttl + 2200
        )
        showOverlay(
            Self.stringValue(message["message"]) ?? Self.labels[state] ?? state,
            Self.stringValue(message["detail"]) ?? "",
            state,
            ttl
        )
        if state == "SUCCESS" || state == "ERROR" {
            notifyAlert(state, detail: Self.stringValue(message["detail"]))
        }
        contentView?.needsDisplay = true
    }

    private func handleTask(_ message: [String: Any]) {
        task = Self.stringValue(message["task"]) ?? ""
        showStatus(
            Self.stringValue(message["message"]) ?? task,
            Self.stringValue(message["detail"]) ?? "",
            model.baseState,
            Self.persistentStates.contains(model.baseState) ? nil : 6000
        )
        contentView?.needsDisplay = true
    }

    private func applyConfig(_ message: [String: Any]) {
        if let url = message["openUrl"] as? String { webuiURL = url }
        if let label = message["openLabel"] as? String { openLabel = label }
        if let list = message["providers"] as? [[String: Any]] {
            providers = list.compactMap { item in
                guard let id = item["id"] as? String else { return nil }
                return (id: id, label: (item["label"] as? String) ?? id)
            }
        }
        if message.keys.contains("provider") { provider = (message["provider"] as? String) ?? "" }
        if let level = message["whisperLevel"] as? String, ["off", "low", "high"].contains(level) { whisperLevel = level }
        if let list = message["characters"] as? [[String: Any]] {
            characters = list.compactMap { item in
                guard let id = item["id"] as? String else { return nil }
                return (id: id, name: (item["name"] as? String) ?? id)
            }
        }
        if let value = message["character"] as? String { character = value }
        var changed = false
        if let value = Self.doubleValue(message["scale"]), value != scale {
            scale = Self.clampedScale(value)
            changed = true
        }
        if let value = Self.doubleValue(message["bubbleScale"]), value != bubbleScale {
            bubbleScale = Self.clampedBubbleScale(value)
            changed = true
        }
        if let value = message["reducedMotion"] as? Bool, value != reducedMotion {
            setReducedMotion(value)
            changed = true
        }
        if let value = message["soundEnabled"] as? Bool {
            soundEnabled = value
        }
        if let value = message["activityLevel"] as? String, ["quiet", "normal", "lively"].contains(value) {
            activityLevel = value
            if !reducedMotion {
                scheduleMicro()
            }
        }
        if let value = message["bubbleMode"] as? String, ["auto", "always", "hidden", "custom"].contains(value) {
            bubbleMode = value
            changed = true
        }
        if let value = message["bubbleStates"] as? [String] {
            bubbleStates = value
            changed = true
        }
        if changed {
            resizeAndReposition()
            saveLayout()
        }
    }

    func quit(reason: String, reportClosed: Bool = true) {
        guard !quitting else { return }
        quitting = true
        saveLayout()
        animTimer?.invalidate()
        keepFrontTimer?.invalidate()
        microTimer?.invalidate()
        clickThroughTimer?.invalidate()
        if reportClosed {
            ProtocolIO.shared.write([
                "protocolVersion": 1,
                "kind": "closed",
                "reason": reason,
                "timestamp": Self.nowMs(),
            ])
        }
        panel?.close()
        NSApp.terminate(nil)
    }

    // MARK: - Status helpers

    private func showStatus(_ message: String, _ detail: String, _ state: String, _ ttlMs: Int?) {
        statusMessage = message
        statusDetail = detail
        statusState = state
        statusDeadlineMs = ttlMs.map { Self.nowMs() + $0 }
    }

    private func showOverlay(_ message: String, _ detail: String, _ state: String, _ ttlMs: Int) {
        overlayMessage = message
        overlayDetail = detail.isEmpty ? statusDetail : detail
        overlayState = state
        overlayDeadlineMs = Self.nowMs() + ttlMs
    }

    private func clearOverlay() {
        overlayMessage = ""
        overlayDetail = ""
        overlayState = nil
        overlayDeadlineMs = nil
    }

    func currentCard() -> (title: String, detail: String, state: String)? {
        let now = Self.nowMs()
        if !overlayMessage.isEmpty, overlayDeadlineMs == nil || now < overlayDeadlineMs! {
            return (overlayMessage, overlayDetail, overlayState ?? statusState)
        }
        if !statusMessage.isEmpty, statusDeadlineMs == nil || now < statusDeadlineMs! {
            return (statusMessage, statusDetail, statusState)
        }
        return nil
    }

    private func bubbleVisible() -> Bool {
        if bubbleMode == "hidden" { return false }
        if bubbleMode == "always" { return true }
        // Working, or something to say; an idle pet keeps quiet.
        if bubbleMode == "auto" { return tasks.count >= 2 || currentCard() != nil }
        if tasks.count >= 2 {
            return tasks.contains { task in
                guard let state = task["state"] as? String else { return false }
                return bubbleStates.contains(state)
            }
        }
        return bubbleStates.contains(overlayState ?? statusState)
    }

    private func notifyAlert(_ state: String, detail: String? = nil) {
        if soundEnabled && state != "WAITING" {
            let filename = state == "SUCCESS" ? "success" : "error"
            // assetRoot is <assets>/pet; sounds sit beside it.
            var url = assetRoot.deletingLastPathComponent().appendingPathComponent("sounds/\(filename).wav")
            if !FileManager.default.fileExists(atPath: url.path) {
                // Other characters live outside the package; sounds stay in it.
                url = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
                    .deletingLastPathComponent().deletingLastPathComponent()
                    .appendingPathComponent("assets/sounds/\(filename).wav")
            }
            if let sound = NSSound(contentsOf: url, byReference: true) {
                sound.play()
            }
        }
        Permissions.requestNotificationAuthorizationIfNeeded()
        guard Bundle.main.bundleIdentifier != nil else { return }
        let content = UNMutableNotificationContent()
        let titles = ["SUCCESS": "任务完成", "ERROR": "任务出错", "WAITING": "需要你确认"]
        let fallbacks = ["SUCCESS": "Agent 任务已完成", "ERROR": "Agent 任务遇到问题", "WAITING": "Agent 在等你确认或回答"]
        content.title = titles[state] ?? "大肥鱼"
        content.body = (detail?.isEmpty == false ? detail : nil) ?? fallbacks[state] ?? ""
        content.sound = soundEnabled ? .default : nil
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                FileHandle.standardError.write(Data("Notification error: \(error)\n".utf8))
            }
        }
    }

    private func restartAnimTimer() {
        lastTickMs = Self.nowMs()
        startAnimTimer()
    }

    // MARK: - Drawing

    func drawPet(in view: NSView) {
        guard let image = frameImage(for: model.frame) else { return }
        var fadeAlpha: CGFloat = 1
        var fadeImage: NSImage?
        if let fromFrame = fadeFromFrame, let fromImage = frameImage(for: fromFrame) {
            let elapsed = CACurrentMediaTime() - fadeStarted
            if elapsed < fadeDuration {
                fadeAlpha = min(1, pow(CGFloat(elapsed / fadeDuration), 0.7))
                fadeImage = fromImage
            } else {
                fadeFromFrame = nil
            }
        }

        let pet = petRect()
        let drawWidth = pet.width
        let drawHeight = pet.height
        let x = pet.minX
        let y = pet.minY
        let centerX = x + drawWidth / 2
        let centerY = y + drawHeight / 2

        func draw(_ img: NSImage, alpha: CGFloat) {
            NSGraphicsContext.saveGraphicsState()
            guard let ctx = NSGraphicsContext.current?.cgContext else {
                NSGraphicsContext.restoreGraphicsState()
                return
            }
            ctx.saveGState()
            // Frames are drawn larger than their pixels on Retina screens;
            // high-quality filtering keeps the line art from turning jagged.
            ctx.interpolationQuality = .high
            ctx.translateBy(x: centerX, y: centerY)
            // The content view is flipped (top-left origin). NSImage drawing
            // does not compensate for a flipped context, which would render
            // the pet vertically mirrored. Mirror about the image's own
            // center so it draws right-side up while staying in place.
            ctx.scaleBy(x: 1, y: -1)
            // Wide clips keep the pet's scale and centre; only their width differs.
            let width = img.size.width * drawWidth / maxFrameWidth
            img.draw(
                in: NSRect(x: -width / 2, y: -drawHeight / 2, width: width, height: drawHeight),
                from: NSRect(origin: .zero, size: img.size),
                operation: .sourceOver,
                fraction: alpha
            )
            ctx.restoreGState()
            NSGraphicsContext.restoreGraphicsState()
        }

        if fadeAlpha < 1, let fadeImage = fadeImage {
            draw(fadeImage, alpha: 1)
        }
        draw(image, alpha: fadeAlpha)
    }

    func drawCard(in view: NSView) {
        guard bubbleVisible() else { return }
        let rect = bubbleRect()
        guard rect.width > 0, rect.height > 0 else { return }
        drawBubbleShape(rect)
        let s = bubbleScale
        if tasks.count >= 2 {
            drawTaskCard(rect: rect)
        } else if let content = bubbleContent() {
            let inset = 16 * s
            let textRect = rect.insetBy(dx: inset, dy: 0)
            drawText(content.title,
                     in: NSRect(x: textRect.minX, y: rect.minY + 12 * s, width: textRect.width, height: 20 * s),
                     font: bubbleTitleFont, color: Self.bubbleText, alignment: .center)
            if !content.detail.isEmpty {
                drawText(content.detail,
                         in: NSRect(x: textRect.minX, y: rect.minY + 36 * s, width: textRect.width, height: 16 * s),
                         font: bubbleDetailFont, color: Self.bubbleSubtext, alignment: .center)
            }
        }
        if !balanceSummary.isEmpty {
            drawText(balanceSummary,
                     in: NSRect(x: rect.minX + 16 * s, y: rect.maxY - footerHeight - 2 * s,
                                width: rect.width - 32 * s, height: footerHeight),
                     font: bubbleFooterFont, color: Self.bubbleSubtext, alignment: .center)
        }
    }

    /// White rounded bubble with a tail pointing down at the pet's head.
    private func drawBubbleShape(_ rect: NSRect) {
        let s = bubbleScale
        let radius = min(18 * s, rect.height / 2)
        let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        let tailWidth = Self.bubbleTail.width * s
        let tailX = min(max(petRect().midX, rect.minX + radius + tailWidth / 2), rect.maxX - radius - tailWidth / 2)
        let tail = NSBezierPath()
        // The content view is flipped: larger y is further down.
        tail.move(to: NSPoint(x: tailX - tailWidth / 2, y: rect.maxY - 1))
        tail.line(to: NSPoint(x: tailX, y: rect.maxY + Self.bubbleTail.height * s))
        tail.line(to: NSPoint(x: tailX + tailWidth / 2, y: rect.maxY - 1))
        tail.close()
        path.append(tail)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowBlurRadius = 8
        shadow.shadowOffset = NSSize(width: 0, height: -2)
        shadow.shadowColor = Self.bubbleShadow
        shadow.set()
        Self.bubbleFill.setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawTaskCard(rect: NSRect) {
        let s = bubbleScale
        let textX = rect.minX + 16 * s
        let textWidth = max(40, rect.width - 32 * s)
        let titleFont = bubbleTitleFont
        let detailFont = bubbleDetailFont
        drawText(
            "\(tasks.count) 个任务进行中",
            in: NSRect(x: textX, y: rect.minY + 12 * s, width: textWidth, height: max(12, 20 * s)),
            font: titleFont,
            color: Self.bubbleText
        )

        for (index, task) in tasks.prefix(3).enumerated() {
            let rowY = rect.minY + (38 + CGFloat(index) * 22) * s
            let state = Self.stringValue(task["state"]) ?? "IDLE"
            let stateLabel = Self.labels[state] ?? state
            let label = Self.stringValue(task["project"])
                ?? Self.stringValue(task["task"])
                ?? Self.stringValue(task["message"])
                ?? stateLabel
            let line = "\(stateLabel) · \(label)"
            let (_, fgHex) = Self.statusColors[state] ?? ("#ECEEF1", "#747A84")
            Self.hex(fgHex).setFill()
            NSBezierPath(ovalIn: NSRect(x: textX, y: rowY + 4 * s, width: 8 * s, height: 8 * s)).fill()
            drawText(
                line,
                in: NSRect(x: textX + 14 * s, y: rowY, width: textWidth - 14 * s, height: max(12, 20 * s)),
                font: detailFont,
                color: Self.bubbleSubtext
            )
        }
        if tasks.count > 3 {
            drawText(
                "还有 \(tasks.count - 3) 个任务…",
                in: NSRect(x: textX + 14 * s, y: rect.minY + (38 + 3 * 22) * s,
                           width: textWidth, height: max(12, 20 * s)),
                font: detailFont,
                color: Self.bubbleSubtext
            )
        }
    }

    private func drawText(_ text: String, in rect: NSRect, font: NSFont, color: NSColor,
                          alignment: NSTextAlignment = .left) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        paragraph.alignment = alignment
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ]
        (text as NSString).draw(in: rect, withAttributes: attributes)
    }

    private func strokeLine(from: NSPoint, to: NSPoint, width: CGFloat, color: NSColor) {
        color.setStroke()
        let path = NSBezierPath()
        path.lineWidth = width
        path.lineCapStyle = .round
        path.move(to: from)
        path.line(to: to)
        path.stroke()
    }

    // MARK: - Misc

    private func maybeSaveSnapshot() {
        guard let snapshotURL = snapshotURL, !snapshotSaved, !isHeadless() else { return }
        snapshotSaved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self = self, let view = self.contentView else { return }
            if let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) {
                    try? data.write(to: snapshotURL)
                }
            }
        }
    }

    private func logEvent(_ message: [String: Any]) {
        guard let eventLogURL = eventLogURL,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let line = String(data: data, encoding: .utf8) else { return }
        let payload = Data((line + "\n").utf8)
        if let handle = try? FileHandle(forWritingTo: eventLogURL) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: payload)
        } else {
            try? payload.write(to: eventLogURL)
        }
    }

    static func clampedScale(_ value: Double) -> Double {
        min(1.4, max(0.55, value))
    }

    static func clampedBubbleScale(_ value: Double) -> Double {
        min(1.2, max(0.8, value))
    }

    private static func stringValue(_ value: Any?) -> String? {
        if let string = value as? String { return string }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let double = value as? Double { return Int(double) }
        if let string = value as? String { return Int(string) }
        return nil
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        if let double = value as? Double { return double }
        if let int = value as? Int { return Double(int) }
        if let string = value as? String { return Double(string) }
        return nil
    }

    private static func nowMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private func reportSettings(_ values: [String: Any]) {
        ProtocolIO.shared.write([
            "protocolVersion": 1,
            "kind": "settings",
            "timestamp": Self.nowMs(),
        ].merging(values) { _, new in new })
    }

    private static func hex(_ hex: String) -> NSColor {
        let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if value.count == 6 {
            let red = Double(Int(value.prefix(2), radix: 16) ?? 0) / 255
            let green = Double(Int(value.dropFirst(2).prefix(2), radix: 16) ?? 0) / 255
            let blue = Double(Int(value.dropFirst(4).prefix(2), radix: 16) ?? 0) / 255
            return NSColor(calibratedRed: red, green: green, blue: blue, alpha: 1)
        }
        return .gray
    }
}
