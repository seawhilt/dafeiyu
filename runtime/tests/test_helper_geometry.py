"""Exercise the real Qt window when PySide6 is installed for Helper builds."""

import os
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

try:
    from PySide6.QtCore import QRect, QTimer
    from PySide6.QtGui import QDesktopServices
    from PySide6.QtWidgets import QApplication
except ImportError:
    QApplication = None

from runtime.helper import EventRecorder, run_visual
from runtime.pet_geometry import Fling, tilt_allowance


@unittest.skipUnless(QApplication is not None, 'Qt integration runs with the Helper build dependencies')
class HelperGeometryTests(unittest.TestCase):
    def test_cards_alerts_and_drag_keep_the_rendered_and_saved_anchor_equal(self) -> None:
        original_exec = QApplication.exec
        finished = threading.Event()
        errors = []

        class WaitingInput:
            def __iter__(self):
                finished.wait(30)
                return iter(())

        def scripted_exec(app):
            window = next(w for w in app.topLevelWidgets() if hasattr(w, 'model'))

            def scenario():
                try:
                    window._screen_geometry_at = lambda x, y: QRect(0, 0, 1920, 1040)

                    def message(kind, **fields):
                        window.apply_message({'protocolVersion': 1, 'kind': kind, 'timestamp': 0, **fields})

                    def assert_anchor(expected):
                        self.assertEqual((window.pet_x, window.pet_y), expected)
                        x, y, _, _ = window._pet_rect()
                        self.assertEqual((window.x() + x, window.y() + y), expected)

                    message('config', soundEnabled=False, bubbleMode='hidden', scale=1.0, bubbleScale=1.0)
                    for expected in ((200, 30), (1508, 696)):
                        window._move_to_pet(*expected)
                        for mode in ('always', 'custom', 'hidden'):
                            message('config', bubbleMode=mode)
                            message('balance', summary='余额测试')
                            message('tasks', tasks=[{'state': 'WORKING'}] * 3)
                            assert_anchor(expected)
                            message('pulse', state='SUCCESS', ttlMs=2200, resumeState='IDLE')
                            window._begin_drag()
                            window._move_to_pet(*expected)
                            message('tasks', tasks=[])
                            message('balance', summary='')
                            window._finish_drag()
                            for _ in range(10):
                                window._tick()
                            assert_anchor(expected)
                        window.grab()  # Painting must use the same rectangle as hit testing.
                    # A thrown pet flies on, bounces off the right edge, falls,
                    # comes to rest on the floor and is saved where it landed.
                    pet_width, pet_height = window._pet_size()
                    window._move_to_pet(1200, 400)
                    window.fling = Fling(1200.0, 400.0, 3000.0, -200.0)
                    for _ in range(1000):
                        if window.fling is None:
                            break
                        window.last_tick_ms -= 16
                        window._tick()
                    self.assertIsNone(window.fling)
                    self.assertLess(window.pet_x, 1920 - pet_width, 'it bounced back off the edge')
                    self.assertEqual(window.pet_y, 1040 - pet_height, 'it rests on the floor')
                    self.assertEqual((window.layout['petX'], window.layout['petY']), (window.pet_x, window.pet_y))
                    # 静止放手下落 drops straight down without bouncing.
                    window._move_to_pet(600, 100)
                    window.fling = Fling(600.0, 100.0, 0.0, 0.0, bouncy=False)
                    for _ in range(200):
                        if window.fling is None:
                            break
                        window.last_tick_ms -= 16
                        window._tick()
                    self.assertEqual((window.pet_x, window.pet_y), (600, 1040 - pet_height))
                    # Display and motion settings from the daemon apply at once.
                    message('config', petOpacity=55, playbackSpeed=2.0, powerSaving=True, lockPosition=True,
                            throwStrength='crazy', dragPhysics=False)
                    self.assertEqual(window.pet_opacity, 55)
                    self.assertEqual((window.playback_speed, window.throw_strength), (2.0, 'crazy'))
                    self.assertFalse(window.drag_physics)
                    normal = window._animation_interval_ms()
                    window.last_touch -= 60
                    self.assertTrue(window._saving_power())
                    self.assertGreater(window._animation_interval_ms(), normal, 'power saving halves the frame rate')
                    message('config', playbackSpeed=1.3, petOpacity=5)
                    self.assertEqual(window.playback_speed, 2.0, 'only listed speeds are taken')
                    self.assertEqual(window.pet_opacity, 10)
                    message('config', powerSaving=False, lockPosition=False, dragPhysics=True, playbackSpeed=1.0,
                            petOpacity=100)
                    # A click squash paints without moving the anchor.
                    anchor = (window.pet_x, window.pet_y)
                    window.squash_started = time.monotonic()
                    window._tick()
                    window.grab()
                    assert_anchor(anchor)
                    # Docked, the pet hangs off the screen side, holds still and
                    # hides its bubble; it comes back out by the same side.
                    window._move_to_pet(30, 400)
                    message('config', bubbleMode='always')
                    message('dock', edge='left')
                    self.assertLess(window.pet_x, 0)
                    self.assertFalse(window._bubble_visible())
                    frame = window.model.frame
                    for _ in range(10):
                        window.last_tick_ms -= 100
                        window._tick()
                    self.assertEqual(window.model.frame, frame)
                    self.assertEqual((window.layout['petX'], window.layout['petY']), (8, 400))
                    # A quarter-turned pet needs its width of vertical room and
                    # is centred in the docked window, or the head gets clipped.
                    pet_width, pet_height = window._pet_size()
                    self.assertGreaterEqual(window.height(), pet_width + 16)
                    _, docked_pet_y, _, _ = window._pet_rect()
                    self.assertAlmostEqual(docked_pet_y + pet_height / 2, window.height() / 2, delta=1)
                    window.grab()
                    message('dock', edge=None)
                    assert_anchor((8, 400))
                    message('config', bubbleMode='hidden')
                    # Undocking restores the upright window size, with room
                    # above and below for the drag lean.
                    allowance = tilt_allowance((pet_width, pet_height))
                    self.assertEqual(window.height(), pet_height + 26 + allowance * 2)
                    with patch.object(QDesktopServices, 'openUrl', return_value=False), patch('sys.stderr'):
                        window._open_client()
                    self.assertEqual(window.overlay_message, '无法打开 DSH')
                    window._move_to_pet(500, 500)
                    message('config', bubbleMode='always')
                    message('pulse', state='SUCCESS', ttlMs=2200, resumeState='IDLE')
                    message('config', bubbleMode='hidden')

                    def after_notification():
                        try:
                            assert_anchor((500, 500))
                        except BaseException as error:
                            errors.append(error)
                        finally:
                            finished.set()
                            app.quit()

                    # Wait beyond the old shake duration to catch stale-origin
                    # restoration after a card resize, rather than just its first tick.
                    QTimer.singleShot(350, after_notification)
                except BaseException as error:
                    errors.append(error)
                    finished.set()
                    app.quit()

            QTimer.singleShot(0, scenario)
            return original_exec()

        with TemporaryDirectory() as directory, patch.dict(os.environ, {
            'QT_QPA_PLATFORM': 'offscreen', 'DAFEIYU_LAYOUT_PATH': str(Path(directory) / 'layout.json'),
        }), patch.object(QApplication, 'exec', scripted_exec), patch.object(sys, 'stdin', WaitingInput()):
            self.assertEqual(run_visual(EventRecorder(None)), 0)
        if errors:
            raise errors[0]


if __name__ == '__main__':
    unittest.main()
