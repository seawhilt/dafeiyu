import CoreGraphics

enum PetGeometry {
    /// A drop this close to a side of the screen docks the pet there.
    static let dockSnapDistance: CGFloat = 16
    /// Share of the docked (rotated) pet that stays on screen: about the head.
    static let dockPeek: CGFloat = 0.6
    /// The steepest lean while dragging, in degrees.
    static let maxTilt: CGFloat = 14
    /// Drag speed, in points per second, per degree of lean.
    static let tiltSpeedPerDegree: CGFloat = 80

    /// Which sides of `screen` are real display edges rather than seams to a
    /// neighbouring display. Two screens meeting at a seam must not both dock.
    static func outerEdges(
        of screen: CGRect,
        among screens: [CGRect],
        tolerance: CGFloat = 1
    ) -> (left: Bool, right: Bool) {
        let others = screens.filter { $0 != screen }
        // A neighbour immediately left shares this screen's left edge and
        // overlaps it vertically; the mirrored test covers the right side.
        let leftSeam = others.contains {
            abs($0.maxX - screen.minX) <= tolerance
                && $0.maxY > screen.minY && $0.minY < screen.maxY
        }
        let rightSeam = others.contains {
            abs($0.minX - screen.maxX) <= tolerance
                && $0.maxY > screen.minY && $0.minY < screen.maxY
        }
        return (left: !leftSeam, right: !rightSeam)
    }

    /// The screen side a pet dropped at `pet` should dock on, if any.
    /// `outerEdges` comes from `outerEdges(of:among:)`: a seam between two
    /// displays is not a screen side to dock against.
    static func dockEdge(
        pet: CGRect,
        screen: CGRect,
        outerEdges: (left: Bool, right: Bool) = (left: true, right: true)
    ) -> String? {
        if outerEdges.left && pet.minX <= screen.minX + dockSnapDistance { return "left" }
        if outerEdges.right && pet.maxX >= screen.maxX - dockSnapDistance { return "right" }
        return nil
    }

    /// The pet's x when docked on `edge`. The pet is turned a quarter so its
    /// height lies along the screen; only the head end stays visible.
    static func dockedX(edge: String, petSize: CGSize, screen: CGRect) -> CGFloat {
        let visible = petSize.height * dockPeek
        let centerX = edge == "left"
            ? screen.minX + visible - petSize.height / 2
            : screen.maxX - visible + petSize.height / 2
        return centerX - petSize.width / 2
    }

    /// The pet's turn when docked, in degrees (positive is clockwise on
    /// screen); the head points into the screen.
    static func dockAngle(edge: String?) -> CGFloat {
        switch edge {
        case "left": return 90
        case "right": return -90
        default: return 0
        }
    }

    /// The lean for a horizontal drag speed, as a turn like `dockAngle`: the
    /// head leans toward the motion, so dragging right turns clockwise.
    static func tilt(forSpeed speed: CGFloat) -> CGFloat {
        min(maxTilt, max(-maxTilt, speed / tiltSpeedPerDegree))
    }

    /// Clamp the character itself, including when its card is wider than it.
    /// At least 35% remains visible on each axis so it can be grabbed again.
    static func clamp(_ point: CGPoint, petSize: CGSize, screen: CGRect) -> CGPoint {
        let keepX = petSize.width * 0.35
        let keepY = petSize.height * 0.35
        return CGPoint(
            x: min(max(point.x, screen.minX - petSize.width + keepX), screen.maxX - keepX),
            y: min(max(point.y, screen.minY - petSize.height + keepY), screen.maxY - keepY)
        )
    }

    /// Whether a point in the panel's view coordinates should receive mouse
    /// events. Everything else in the transparent window must pass clicks
    /// through to the application below (issue #92).
    static func isInteractive(
        _ point: CGPoint,
        pet: CGRect,
        bubble: CGRect?,
        tolerance: CGFloat = 1
    ) -> Bool {
        if pet.insetBy(dx: -tolerance, dy: -tolerance).contains(point) {
            return true
        }
        if let bubble, bubble.insetBy(dx: -tolerance, dy: -tolerance).contains(point) {
            return true
        }
        return false
    }
}
