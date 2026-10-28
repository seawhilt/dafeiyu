import XCTest
@testable import BigFishCore

final class ClipPlayerTests: XCTestCase {
    private static func clip(_ name: String, _ frames: Int, loop: Bool) -> [String: Any] {
        ["frames": (0..<frames).map { "\(name)/\($0)" }, "frameMs": 100, "loop": loop]
    }

    private func makePlayer() -> ClipPlayer {
        ClipPlayer(manifest: [
            "clips": ["idle": Self.clip("idle", 3, loop: true), "poke": Self.clip("poke", 2, loop: false)],
            "stateMap": ["IDLE": "idle"],
        ])
    }

    func testStartsOnTheIdleClip() {
        let player = makePlayer()
        XCTAssertEqual(player.activeClipName, "idle")
        XCTAssertEqual(player.frame, "idle/0")
    }

    func testLoopWrapsAndReportsEachPass() {
        let player = makePlayer()
        XCTAssertNil(player.advance(elapsedMs: 250))
        XCTAssertEqual(player.frame, "idle/2")
        XCTAssertEqual(player.advance(elapsedMs: 100), "idle")
        XCTAssertEqual(player.frame, "idle/0")
    }

    func testOneShotHoldsItsLastFrameAndReportsOnce() {
        let player = makePlayer()
        XCTAssertTrue(player.play("poke"))
        XCTAssertEqual(player.advance(elapsedMs: 500), "poke")
        XCTAssertEqual(player.frame, "poke/1")
        XCTAssertNil(player.advance(elapsedMs: 500))
    }

    func testReplayingTheRunningClipDoesNotRestartIt() {
        let player = makePlayer()
        _ = player.advance(elapsedMs: 150)
        player.play("idle")
        XCTAssertEqual(player.frame, "idle/1")
    }

    func testAHeldClipRestartsWhenPlayedAgain() {
        let player = makePlayer()
        player.play("poke")
        _ = player.advance(elapsedMs: 500)
        player.play("poke")
        XCTAssertEqual(player.frame, "poke/0")
    }

    func testLoopFlagOverridesTheManifest() {
        let player = makePlayer()
        player.play("poke", loop: true)
        XCTAssertEqual(player.advance(elapsedMs: 200), "poke")
        XCTAssertEqual(player.frame, "poke/0")
    }

    func testUnknownClipsAreIgnored() {
        let player = makePlayer()
        XCTAssertFalse(player.play("lunch"))
        XCTAssertEqual(player.activeClipName, "idle")
    }

    func testDragClipsSwitchWithoutAFade() {
        XCTAssertNil(ClipPlayer.crossfadeDuration(previousClip: "idle", currentClip: "dragging"))
        XCTAssertEqual(ClipPlayer.crossfadeDuration(previousClip: "idle", currentClip: "poke"), 0.10)
    }
}
