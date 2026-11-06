import CoreGraphics
import Foundation

/// Throwing and click squash, kept in step with runtime/pet_geometry.py.
enum PetMotion {
    /// A released drag keeps flying when the pointer was still moving fast,
    /// falls under gravity, bounces off the screen edges and comes to rest on
    /// the floor. Numbers from dsh-pet-indesktop (pet/physics.py).
    static let flingMinSpeed: CGFloat = 500  // points/s; a slower release just lets go
    /// Top release speed per 「甩出力度」 choice; same as runtime/pet_geometry.py.
    static let throwStrengthCaps: [String: CGFloat] = ["gentle": 3600, "standard": 4800, "strong": 7200, "crazy": 9000]
    static let flingMaxSpeed: CGFloat = 4800
    static let gravity: CGFloat = 1400  // points/s², toward the floor
    static let restitution: CGFloat = 0.68  // share of speed kept when hitting an edge
    static let groundFriction: CGFloat = 2.5  // per second, while sliding on the floor
    static let floorStopSpeed: CGFloat = 120  // a landing slower than this does not bounce
    static let wallStopSpeed: CGFloat = 60  // a wall hit slower than this stops instead of bouncing
    static let restSpeed: CGFloat = 15  // on the floor and slower than this: at rest
    static let flingSampleWindow: CFTimeInterval = 0.08

    /// A pet in flight. AppKit's y grows upward, so the floor is `minY`.
    struct Fling: Equatable {
        var position: CGPoint
        var velocity: CGVector
        /// A drop (「静止放手下落」) lands without bouncing.
        var bouncy = true
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

    /// Advance a throw or drop by `seconds`; nil once it rests on the floor.
    static func step(_ fling: Fling, seconds: CGFloat, bounds: CGRect) -> Fling? {
        var vx = fling.velocity.dx
        var vy = fling.velocity.dy - gravity * seconds
        var x = fling.position.x + vx * seconds
        var y = fling.position.y + vy * seconds
        if x < bounds.minX || x > bounds.maxX {
            x = min(max(x, bounds.minX), bounds.maxX)
            let speed = abs(vx) < wallStopSpeed ? 0 : abs(vx) * restitution
            vx = x == bounds.minX ? speed : -speed
        }
        if y > bounds.maxY {
            y = bounds.maxY
            vy = -abs(vy) * restitution
        } else if y <= bounds.minY {
            y = bounds.minY
            vx *= max(0, 1 - groundFriction * seconds)
            vy = !fling.bouncy || abs(vy) < floorStopSpeed ? 0 : abs(vy) * restitution
            // Rest only once already on the floor, so the caller has moved
            // the pet onto it first.
            if vy == 0 && abs(vx) < restSpeed && fling.position.y <= bounds.minY { return nil }
        }
        return Fling(position: CGPoint(x: x, y: y), velocity: CGVector(dx: vx, dy: vy), bouncy: fling.bouncy)
    }

    /// 弹弓弹射: while dragging, a right click anchors the pet; pulling the
    /// pointer away and letting go launches it the other way. Distances grow
    /// with the pet's size. Same numbers as runtime/pet_geometry.py.
    static let slingshotMinDistance: CGFloat = 24
    static let slingshotMaxDistance: CGFloat = 160
    static let slingshotBaseSpeed: CGFloat = 900
    static let slingshotMaxStretch: CGFloat = 1.3

    /// The launch direction and strength: from the pointer back to where aiming began.
    static func slingshotPull(from anchor: CGPoint, to cursor: CGPoint, scale: CGFloat) -> CGVector {
        var pull = CGVector(dx: anchor.x - cursor.x, dy: anchor.y - cursor.y)
        let length = hypot(pull.dx, pull.dy)
        let limit = slingshotMaxDistance * scale
        if length > limit {
            pull = CGVector(dx: pull.dx * limit / length, dy: pull.dy * limit / length)
        }
        return pull
    }

    /// Launch velocity for a pull, or nil when it is too short to fire.
    static func slingshotLaunch(_ pull: CGVector, scale: CGFloat, cap: CGFloat) -> CGVector? {
        let distance = hypot(pull.dx, pull.dy)
        let low = slingshotMinDistance * scale
        let high = slingshotMaxDistance * scale
        guard distance >= low, high > low else { return nil }
        let progress = min(1, (distance - low) / (high - low))
        let eased = 1 - (1 - progress) * (1 - progress)
        let raw = slingshotBaseSpeed + (3 * cap - slingshotBaseSpeed) * eased
        // A soft cap keeps harder pulls faster while never passing the cap.
        let speed = cap * (1 - exp(-raw / cap))
        return CGVector(dx: pull.dx / distance * speed, dy: pull.dy / distance * speed)
    }

    /// (width, height) scale of the pet stretched along the pull.
    static func slingshotStretch(_ pull: CGVector, scale: CGFloat) -> (x: CGFloat, y: CGFloat) {
        let distance = hypot(pull.dx, pull.dy)
        guard distance > 1e-6 else { return (1, 1) }
        let progress = min(1, distance / (slingshotMaxDistance * scale))
        let ux = pull.dx / distance
        let uy = pull.dy / distance
        let stretch = 1 + (slingshotMaxStretch - 1) * progress
        let squeeze = 1 - (1 - 1 / slingshotMaxStretch) * progress
        return (hypot(stretch * ux, squeeze * uy), hypot(stretch * uy, squeeze * ux))
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
