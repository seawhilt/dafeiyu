import CoreGraphics
import XCTest
@testable import BigFishCore

/// Mirrors runtime/tests/test_pet_motion.py so both helpers throw alike.
final class PetMotionTests: XCTestCase {
    private func sample(_ x: CGFloat, _ y: CGFloat, _ time: CFTimeInterval) -> PetMotion.Sample {
        PetMotion.Sample(point: CGPoint(x: x, y: y), time: time)
    }

    func testAQuickFlickThrowsThePet() {
        let velocity = PetMotion.flingVelocity([sample(100, 500, 1.00), sample(130, 495, 1.02), sample(190, 485, 1.04)], now: 1.05)
        XCTAssertEqual(velocity?.dx ?? 0, 2250, accuracy: 0.01)
        XCTAssertEqual(velocity?.dy ?? 0, -375, accuracy: 0.01)
    }

    func testASlowDragOrAPauseJustDrops() {
        XCTAssertNil(PetMotion.flingVelocity([sample(100, 500, 1.00), sample(110, 500, 1.04)], now: 1.05))
        XCTAssertNil(PetMotion.flingVelocity([sample(100, 500, 1.00), sample(190, 500, 1.04)], now: 1.13))
        XCTAssertNil(PetMotion.flingVelocity([sample(0, 0, 0), sample(900, 0, 0.1), sample(905, 0, 0.2), sample(910, 0, 0.25)], now: 0.25))
        XCTAssertNil(PetMotion.flingVelocity([sample(0, 0, 1)], now: 1))
    }

    func testAWildFlickIsCapped() {
        let velocity = PetMotion.flingVelocity([sample(0, 0, 1.00), sample(900, 0, 1.01)], now: 1.01)
        XCTAssertEqual(velocity?.dx ?? 0, PetMotion.flingMaxSpeed, accuracy: 0.01)
    }

    func testAThrowSlowsDownAndBouncesOffEdges() {
        let screen = CGRect(x: 0, y: 0, width: 1920, height: 1040)
        let bounds = PetMotion.flingBounds(petSize: CGSize(width: 200, height: 160), screen: screen)
        XCTAssertEqual(bounds, CGRect(x: 0, y: 0, width: 1720, height: 880))
        let hit = PetMotion.step(.init(position: CGPoint(x: 1710, y: 400), velocity: CGVector(dx: 3000, dy: 0)), seconds: 1 / 60, bounds: bounds)
        XCTAssertEqual(hit?.position.x, 1720)
        XCTAssertLessThan(hit?.velocity.dx ?? 0, 0)
        var fling: PetMotion.Fling? = .init(position: CGPoint(x: 500, y: 400), velocity: CGVector(dx: 1350, dy: 0))
        var steps = 0
        while let current = fling, steps < 1000 {
            fling = PetMotion.step(current, seconds: 1 / 60, bounds: bounds)
            steps += 1
        }
        XCTAssertLessThan(steps, 120)
    }

    func testAClickSquashesThenSpringsBack() {
        let start = PetMotion.squash(elapsedMs: 0)
        XCTAssertLessThan(start?.y ?? 1, 1)
        XCTAssertGreaterThan(start?.x ?? 1, 1)
        XCTAssertNil(PetMotion.squash(elapsedMs: PetMotion.squashMs))
        XCTAssertNil(PetMotion.squash(elapsedMs: -1))
        let overshoots = stride(from: 0.0, to: PetMotion.squashMs, by: 10).contains { (PetMotion.squash(elapsedMs: $0)?.y ?? 0) > 1 }
        XCTAssertTrue(overshoots)
    }
}
