import Foundation

/// Plays the clip the daemon chose and reports the end of each pass.
///
/// The daemon's pet director (src/pet-director.js) decides every animation;
/// the helper only times frames, loops or holds the last frame, and reports
/// when a pass ends so the director can pick what follows.
final class ClipPlayer {
    struct Clip {
        let name: String
        let frames: [String]
        let frameMs: Int
        let loop: Bool
    }

    private static let dragClips: Set<String> = ["dragging", "dragging_release"]

    /// Fade clip changes only; never blend successive 24 fps video frames.
    static func crossfadeDuration(previousClip: String, currentClip: String) -> Double? {
        if previousClip == currentClip || dragClips.contains(previousClip) || dragClips.contains(currentClip) {
            return nil
        }
        return 0.10
    }

    private(set) var clips: [String: Clip] = [:]
    private(set) var activeClipName = "idle"
    private(set) var loop = true
    private(set) var frameIndex = 0
    private(set) var frameElapsedMs = 0
    /// A one-shot clip that reached its last frame and waits for the next play.
    private(set) var held = false

    init(manifest: [String: Any]) {
        if let clipsDict = manifest["clips"] as? [String: Any] {
            for (name, value) in clipsDict {
                guard let v = value as? [String: Any],
                      let frames = v["frames"] as? [String] else { continue }
                clips[name] = Clip(
                    name: name,
                    frames: frames,
                    frameMs: max(1, Self.asInt(v["frameMs"], fallback: 180)),
                    loop: (v["loop"] as? Bool) ?? false
                )
            }
        }
        if let idle = (manifest["stateMap"] as? [String: String])?["IDLE"], !idle.isEmpty {
            activeClipName = idle
        }
        loop = activeClip.loop
    }

    var activeClip: Clip {
        clips[activeClipName] ?? Clip(name: activeClipName, frames: [], frameMs: 180, loop: false)
    }

    var frame: String {
        activeClip.frames.isEmpty ? "" : activeClip.frames[frameIndex]
    }

    /// Switch clips; playing the running clip again does not restart it.
    ///
    /// `settleLastFrame` is for reduced motion: a one-shot clip then rests on
    /// its end pose (the result) instead of being frozen on its first frame,
    /// because the helper never animates it under reduced motion.
    @discardableResult
    func play(_ clipName: String, loop requestedLoop: Bool? = nil, settleLastFrame: Bool = false) -> Bool {
        guard let clip = clips[clipName] else { return false }
        if clipName == activeClipName && !held {
            if settleLastFrame { holdLastFrame() }
            return true
        }
        activeClipName = clipName
        loop = requestedLoop ?? clip.loop
        frameIndex = 0
        frameElapsedMs = 0
        held = false
        if settleLastFrame { holdLastFrame() }
        return true
    }

    /// Rest on a one-shot clip's final pose; looping clips stay put.
    private func holdLastFrame() {
        guard !loop, !activeClip.frames.isEmpty else { return }
        frameIndex = activeClip.frames.count - 1
        frameElapsedMs = 0
        held = true
    }

    /// Move on; return the clip name when a pass ended during this step.
    func advance(elapsedMs: Int) -> String? {
        let clip = activeClip
        guard !held, elapsedMs >= 0, !clip.frames.isEmpty else { return nil }
        let total = frameElapsedMs + elapsedMs
        let nextFrame = frameIndex + total / clip.frameMs
        frameElapsedMs = total % clip.frameMs
        if nextFrame < clip.frames.count {
            frameIndex = nextFrame
            return nil
        }
        if loop {
            frameIndex = nextFrame % clip.frames.count
        } else {
            frameIndex = clip.frames.count - 1
            frameElapsedMs = 0
            held = true
        }
        return clip.name
    }

    private static func asInt(_ value: Any?, fallback: Int) -> Int {
        if let int = value as? Int { return int }
        if let double = value as? Double { return Int(double) }
        return fallback
    }
}
