"""Overlay geometry checks without creating a Tk window or reading the desktop."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/coach_overlay'))
from coach_overlay import CoachOverlay

class GeometryTests(unittest.TestCase):
    def validate(self, geometry, actual, target=42):
        app=CoachOverlay.__new__(CoachOverlay)
        app._last_generation=None;app.max_age=0;app._state_signature=None
        app.virtual=(-100,0,2000,1200)
        state={'visible':True,'generation':1,'target_hwnd':target,
               'window_geometry':geometry,'steps':[{'rect':[0,20,36,36],'text':'test'}]}
        with patch('coach_overlay.visible_frame',side_effect=lambda hwnd:actual[hwnd]), \
             patch('coach_overlay.user32.IsWindowVisible',return_value=True), \
             patch('coach_overlay.user32.IsIconic',return_value=False), \
             patch('coach_overlay.window_rect',side_effect=AssertionError('wrong coordinate convention')):
            return app._validate(state)

    def test_visible_bounds_accept_negative_origin_and_reject_move_resize(self):
        geometry=[{'hwnd':42,'rect':[-50,0,500,400]}]
        self.assertIsNotNone(self.validate(geometry,{42:[-50,0,500,400]}))
        for actual in ([-40,0,510,400],[-50,0,600,400]):
            self.assertIsNone(self.validate(geometry,{42:actual}))

    def test_owner_and_dialog_checked_individually_not_union(self):
        geometry=[{'hwnd':42,'rect':[-50,0,500,400]}, {'hwnd':99,'rect':[100,100,600,500]}]
        actual={42:[-50,0,500,400],99:[100,100,600,500]}
        self.assertIsNotNone(self.validate(geometry,actual,99))
        actual[42]=[-49,0,500,400]
        self.assertIsNone(self.validate(geometry,actual,99))

    def test_missing_window_and_unbound_target_rejected(self):
        geometry=[{'hwnd':42,'rect':[0,0,500,400]}]
        self.assertIsNone(self.validate(geometry,{}))
        self.assertIsNone(self.validate(geometry,{42:[0,0,500,400]},99))

if __name__=='__main__': unittest.main()
