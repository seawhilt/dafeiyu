import CoreGraphics
import Foundation

/// Throwing and click squash, kept in step with runtime/pet_geometry.py.
enum PetMotion {
    /// A released drag keeps flying when the pointer was still moving fast.
    static let flingMinSpeed: CGFloat = 900  // points/s over the last moment of the drag
    /// Top release speed per 「甩出力度」 choice; same as runtime/pet_geometry.py.
    static let throwStrengthCaps: [String: CGFloat] = ["gentle": 3600, "standard": 4800, "strong": 7200, "crazy": 9000]
    static let flingMaxSpeed: CGFloat = 4800
    static let flingStopSpeed: CGFloat = 60
    static let flingFriction: CGFloat = 4  // per second
    static let flingBounce: CGFloat = 0.45  // share of speed kept at a screen edge
    static let flingSampleWindow: CFTimeInterval = 0.08

    struct Fling: Equatable {
        var position: CGPoint
        var velocity: CGVector
    }

    struct Sample {
        let point: CGPoint
        let time: CFTimeInterval
    }

    /// Release speed from drag samples, or nil for a plain drop.
    static func flingVelocity(_ samples: [Sample], now: CFTimeInterval, maxSpeed: CGFloat = flingMaxSpeed) -> CGVector? {
        guard samples.count >= 2, let last = samples.last, now - last.time <= flingSampleWindow,
              let first = samples.first(where: { last.time - $0.time <= flingSampleWindow }) else { return nil }
        let elapsed = CGFloat(last.time - first.time)
        guard elapsed > 0 else { return nil }
        let dx = (last.point.x - first.point.x) / elapsed
        let dy = (last.point.y - first.point.y) / elapsed
        let speed = hypot(dx, dy)
        guard speed >= flingMinSpeed else { return nil }
        let cap = min(1, maxSpeed / speed)
        return CGVector(dx: dx * cap, dy: dy * cap)
    }

    /// Where the pet's origin may fly so all of it stays on `screen`.
    static func flingBounds(petSize: CGSize, screen: CGRect) -> CGRect {
        CGRect(
            x: screen.minX,
            y: screen.minY,
            width: max(0, screen.width - petSize.width),
            height: max(0, screen.height - petSize.height)
        )
    }

    private static func bounce(_ position: CGFloat, _ speed: CGFloat, _ low: CGFloat, _ high: CGFloat) -> (CGFloat, CGFloat) {
        if position < low { return (low, abs(speed) * flingBounce) }
        if position > high { return (high, -abs(speed) * flingBounce) }
        return (position, speed)
    }

    /// Advance a throw by `seconds`; nil once it has come to rest.
    static func step(_ fling: Fling, seconds: CGFloat, bounds: CGRect) -> Fling? {
        let decay = exp(-flingFriction * seconds)
        let vx = fling.velocity.dx * decay
        let vy = fling.velocity.dy * decay
        let (x, nextVX) = bounce(fling.position.x + vx * seconds, vx, bounds.minX, bounds.maxX)
        let (y, nextVY) = bounce(fling.position.y + vy * seconds, vy, bounds.minY, bounds.maxY)
        guard hypot(nextVX, nextVY) >= flingStopSpeed else { return nil }
        return Fling(position: CGPoint(x: x, y: y), velocity: CGVector(dx: nextVX, dy: nextVY))
    }

    /// A click squashes the pet at its feet and lets it spring back.
    static let squashMs: Double = 480
    static let squashDepth: Double = 0.12
    static let squashDecayMs: Double = 110
    static let squashPeriodMs: Double = 240
    static let squashWiden: Double = 0.5

    /// (width, height) scale `elapsedMs` after a click, nil when done.
    static func squash(elapsedMs: Double) -> (x: CGFloat, y: CGFloat)? {
        guard elapsedMs >= 0, elapsedMs < squashMs else { return nil }
        let amount = squashDepth * exp(-elapsedMs / squashDecayMs) * cos(2 * .pi * elapsedMs / squashPeriodMs)
        return (CGFloat(1 + amount * squashWiden), CGFloat(1 - amount))
    }
}
