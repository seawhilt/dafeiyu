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
        XCTAssertEqual(PetMotion.flingMinSpeed, 500)
        XCTAssertNil(PetMotion.flingVelocity([sample(100, 500, 1.00), sample(190, 500, 1.04)], now: 1.13))
        XCTAssertNil(PetMotion.flingVelocity([sample(0, 0, 0), sample(900, 0, 0.1), sample(905, 0, 0.2), sample(910, 0, 0.25)], now: 0.25))
        XCTAssertNil(PetMotion.flingVelocity([sample(0, 0, 1)], now: 1))
    }

    func testAWildFlickIsCapped() {
        let velocity = PetMotion.flingVelocity([sample(0, 0, 1.00), sample(900, 0, 1.01)], now: 1.01)
        XCTAssertEqual(velocity?.dx ?? 0, PetMotion.flingMaxSpeed, accuracy: 0.01)
    }

    func testTheThrowStrengthSetsTheCap() {
        let samples = [sample(0, 0, 1.00), sample(900, 0, 1.01)]
        for (strength, cap) in PetMotion.throwStrengthCaps {
            XCTAssertEqual(PetMotion.flingVelocity(samples, now: 1.01, maxSpeed: cap)?.dx ?? 0, cap, accuracy: 0.01, strength)
        }
        XCTAssertEqual(PetMotion.flingMaxSpeed, PetMotion.throwStrengthCaps["standard"])
    }

    private let bounds = PetMotion.flingBounds(petSize: CGSize(width: 200, height: 160), screen: CGRect(x: 0, y: 0, width: 1920, height: 1040))

    private func settle(_ start: PetMotion.Fling) -> (last: PetMotion.Fling, steps: Int) {
        var fling: PetMotion.Fling? = start
        var last = start
        var steps = 0
        while let current = fling, steps < 1000 {
            last = current
            fling = PetMotion.step(current, seconds: 1 / 60, bounds: bounds)
            steps += 1
        }
        XCTAssertNil(fling)
        return (last, steps)
    }

    func testAThrowArcsDownAndRestsOnTheFloor() {
        XCTAssertEqual(bounds, CGRect(x: 0, y: 0, width: 1720, height: 880))
        let (last, steps) = settle(.init(position: CGPoint(x: 500, y: 700), velocity: CGVector(dx: 1500, dy: 600)))
        XCTAssertLessThan(steps, 8 * 60)
        XCTAssertEqual(last.position.y, 0, accuracy: 1)
    }

    func testWallsCeilingAndFloorBounce() {
        let wall = PetMotion.step(.init(position: CGPoint(x: 1710, y: 400), velocity: CGVector(dx: 3000, dy: 0)), seconds: 1 / 60, bounds: bounds)
        XCTAssertEqual(wall?.position.x, 1720)
        XCTAssertEqual(wall?.velocity.dx ?? 0, -3000 * PetMotion.restitution, accuracy: 0.01)
        let slow = PetMotion.step(.init(position: CGPoint(x: 1719.5, y: 400), velocity: CGVector(dx: 40, dy: 0)), seconds: 1 / 60, bounds: bounds)
        XCTAssertEqual(slow?.velocity.dx, 0)
        let ceiling = PetMotion.step(.init(position: CGPoint(x: 500, y: 875), velocity: CGVector(dx: 0, dy: 3000)), seconds: 1 / 60, bounds: bounds)
        XCTAssertEqual(ceiling?.position.y, 880)
        XCTAssertLessThan(ceiling?.velocity.dy ?? 0, 0)
        let floor = PetMotion.step(.init(position: CGPoint(x: 500, y: 5), velocity: CGVector(dx: 0, dy: -3000)), seconds: 1 / 60, bounds: bounds)
        XCTAssertEqual(floor?.position.y, 0)
        XCTAssertGreaterThan(floor?.velocity.dy ?? 0, 0)
    }

    func testADropFallsWithoutBouncing() {
        var fling: PetMotion.Fling? = .init(position: CGPoint(x: 500, y: 780), velocity: .zero, bouncy: false)
        var heights: [CGFloat] = []
        while let current = fling {
            heights.append(current.position.y)
            fling = PetMotion.step(current, seconds: 1 / 60, bounds: bounds)
        }
        XCTAssertEqual(heights, heights.sorted(by: >))
        XCTAssertEqual(heights.last, 0)
        XCTAssertNil(PetMotion.step(.init(position: CGPoint(x: 500, y: 0), velocity: .zero, bouncy: false), seconds: 1 / 60, bounds: bounds))
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
