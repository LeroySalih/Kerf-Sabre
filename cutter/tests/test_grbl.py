from __future__ import annotations

import pytest

from kerf_cutter.grbl import gcode
from kerf_cutter.grbl.jobrun import JobRunner
from kerf_cutter.grbl.link import Link
from kerf_cutter.grbl.state import decode, parse_settings, parse_status, setting
from kerf_cutter.logs import CutterLog

from .fake_grbl import BANNER, FakeClock, FakeGrbl


@pytest.fixture()
def log(tmp_path):
    lg = CutterLog(tmp_path / "logs", "station-1", level="DEBUG")
    yield lg
    lg.close()


def make(log, **kw):
    clock = FakeClock()
    sim = FakeGrbl(**kw)
    return sim, Link(sim, log, clock=clock, sleep=clock.sleep), clock


class TestState:
    def test_status_reports_including_the_hold_substate(self):
        s = parse_status("<Hold:1|MPos:1.500,2.000,0.000|FS:0,0>")
        assert (s.state, s.sub, s.mpos) == ("Hold", 1, [1.5, 2.0, 0.0]) and not s.stopped_hold
        assert parse_status("<Hold:0|MPos:0,0,0|FS:0,0>").stopped_hold
        assert parse_status("<Idle|WPos:3.0,4.0,0.0>").position == [3.0, 4.0, 0.0]
        assert parse_status("ok") is None and parse_status("<garbage>") is None

    def test_settings_and_decoding(self):
        s = parse_settings(["$30=1000.000", "$32=1", "ok", "junk"])
        assert s == {"$30": "1000.000", "$32": "1"} and setting(s, "$30") == 1000 and setting(s, "$99") is None
        assert "needs homing" in decode("ALARM:3") and "Homing is not enabled" in decode("error:5") and decode("what") == "what"


class TestLink:
    def test_no_banner_on_open_but_a_reset_brings_it(self, log):
        sim, link, _ = make(log)
        assert link.wait_for_banner(2) is None  # what the spike saw on every station
        assert link.reset() == BANNER

    def test_commands_status_and_settings(self, log):
        sim, link, _ = make(log, bed=(355, 390))
        assert link.command("G21")[1] == "ok"
        st = link.settings()
        assert st["$130"] == "355.000" and st["$32"] == "1"
        assert link.status().state == "Idle"

    def test_a_command_gives_up_after_its_timeout_and_says_so(self, log):
        sim, link, _ = make(log)
        sim.silent_after = 0
        lines, final = link.command("G0 X1", timeout=2.0)
        assert final == "timeout" and any(e["event"] == "command_timeout" for e in log.recent)

    def test_errors_and_alarms_are_the_final_answer(self, log):
        sim, link, _ = make(log)
        sim.error_on["X9"] = "error:20"
        assert link.command("G1 X9")[1] == "error:20"

    def test_an_abort_interrupts_a_wait(self, log):
        sim, link, _ = make(log)
        sim.silent_after = 0
        assert link.command("G0 X1", timeout=60, abort=lambda: True)[1] == "aborted"

    def test_hold_is_only_stopped_at_hold_0(self, log):
        sim, link, _ = make(log)
        link.realtime(b"!")
        first = link.status()
        assert (first.state, first.sub) == ("Hold", 1)
        assert link.wait_stopped().stopped_hold

    def test_a_dead_port_raises_and_is_logged(self, log):
        sim, link, _ = make(log)
        sim.fail_write_after = 0
        with pytest.raises(OSError):
            link.tx("G21")
        assert any(e["event"] == "serial_write_failed" for e in log.recent)


GOOD = """; Kerf Sabre job job-1
G21
G90
M4 S0
G0 X10 Y10
G1 X50 Y10 S800 F1200
G1 X50 Y40
G3 X30 Y40 I-10 J0
G0 X0 Y0
M5
"""


class TestScan:
    def test_a_good_job_passes_and_has_bounds_including_the_arc(self):
        s = gcode.scan(GOOD, bed_w=400, bed_h=415, s30_max=1000)
        assert s.ok, s.errors
        assert s.bounds == (0.0, 0.0, 50.0, 50.0)  # the counter-clockwise half circle from (50,40) to (30,40) bulges up to y = 50
        assert s.max_s == 800 and "M5" in s.lines and not any(l.startswith(";") for l in s.lines)

    @pytest.mark.parametrize("bad,why", [
        ("G21\nG90\nG92 X0 Y0\nG1 X5 Y5", "G92"),
        ("G21\nG90\nG91\nG1 X5 Y5", "relative"),
        ("G20\nG90\nG1 X5 Y5", "millimetres"),
        ("G21\nG90\n$H", "settings"),
        ("G21\nG90\nG28", "G28"),
        ("G21\nG90\nM6", "M6"),
        ("G21\nG90\nM3 S1200\nG1 X5 Y5", "maximum"),
        ("G1 X5 Y5\nG21\nG90", "before it has set"),
        ("G21\nG90\nG1 X500 Y5 S100 F100", "outside the bed"),
        ("G21\nG90\nG1 X5 Y-30 S100 F100", "outside the bed"),
    ])
    def test_unsafe_or_wrong_jobs_are_refused(self, bad, why):
        s = gcode.scan(bad, bed_w=400, bed_h=415, s30_max=1000)
        assert not s.ok and any(why in e for e in s.errors), s.errors

    def test_an_arc_that_bulges_off_the_bed_is_caught_even_when_its_ends_are_on_it(self):
        s = gcode.scan("G21\nG90\nG0 X10 Y200\nG3 X10 Y100 I-90 J-50 F1000", bed_w=400, bed_h=415, s30_max=1000)
        assert any("outside the bed" in e for e in s.errors)

    def test_laser_mode_off_forbids_m3_m4_and_empty_is_refused(self):
        assert not gcode.scan("G21\nG90\nM4 S0\nG1 X1 Y1", bed_w=400, bed_h=415, s30_max=1000, laser_mode=False).ok
        assert not gcode.scan("; nothing\n", bed_w=400, bed_h=415, s30_max=1000).ok


def runner(sim, link, clock, lines, log, **kw):
    events = {"progress": [], "states": []}
    r = JobRunner(link, log, "job-1", lines, clock=clock, sleep=clock.sleep, on_progress=lambda *a: events["progress"].append(a), on_state=events["states"].append, **kw)
    return r, events


class TestJobRun:
    LINES = ["G21", "G90", "M4 S0", "G0 X10 Y10", "G1 X20 Y10 S500 F900", "G1 X20 Y20", "M5"]

    def test_a_job_streams_every_line_and_finishes_idle_with_laser_and_air_off(self, log):
        sim, link, clock = make(log)
        r, ev = runner(sim, link, clock, self.LINES, log)
        outcome, msg, secs = r.run()
        assert (outcome, msg) == ("done", "")
        assert sim.lines[: len(self.LINES)] == self.LINES and sim.lines[-2:] == ["M5", "M9"]
        assert ev["progress"][-1][:2] == (7, 7)

    def test_grbl_refusing_a_line_holds_and_resets_and_fails_with_a_reason(self, log):
        sim, link, clock = make(log)
        sim.error_on["Y20"] = "error:20"
        outcome, msg, _ = runner(sim, link, clock, self.LINES, log)[0].run()
        assert outcome == "failed" and "line 6 of 7" in msg and "Unsupported or invalid G-code" in msg
        assert sim.written[-2:] == [b"!", b"\x18"]

    def test_an_alarm_during_the_job_fails_it(self, log):
        sim, link, clock = make(log)
        sim.alarm_after = 1
        lines = ["G21", "G90"] + [f"G1 X{i} Y{i} S100 F900" for i in range(1, 60)]
        outcome, msg, _ = runner(sim, link, clock, lines, log)[0].run()
        assert outcome == "failed" and ("alarm" in msg.lower() or "refused" in msg.lower())
        assert sim.written[-2:] == [b"!", b"\x18"]

    def test_the_laser_going_silent_fails_the_job_instead_of_hanging(self, log):
        sim, link, clock = make(log)
        sim.silent_after = 3
        outcome, msg, _ = runner(sim, link, clock, self.LINES, log)[0].run()
        assert outcome == "failed" and "stopped answering" in msg

    def test_a_line_that_waits_for_the_machine_to_finish_moving_is_not_a_timeout(self, log):
        """Real GRBL answers M9 (and M5) only once the queued moves have run; on a slow cut that is far longer than 15 s. The station saw
        'The laser stopped answering at line 36 of 38 (M9)' while the status still said Run."""
        sim, link, clock = make(log)
        sim.slow_ok["M9"] = 3  # three 15 s waits, each time the status says Run
        lines = ["G21", "G90", "G1 X10 Y10 S100 F180", "M5", "M9"]
        outcome, msg, secs = runner(sim, link, clock, lines, log)[0].run()
        assert (outcome, msg) == ("done", "")
        assert secs > 30  # it really did wait for the machine
        assert not any(b == b"\x18" for b in sim.written)  # and never reset it

    def test_a_laser_that_is_busy_for_ever_still_fails_in_the_end(self, log):
        sim, link, clock = make(log)
        sim.slow_ok["M9"] = 10_000
        outcome, msg, _ = runner(sim, link, clock, ["G21", "G90", "M9"], log)[0].run()
        assert outcome == "failed" and "stopped answering at line 3 of 3" in msg

    def test_an_idle_laser_that_does_not_answer_is_a_timeout_at_once(self, log):
        sim, link, clock = make(log)
        sim.silent_after = 2  # lines are swallowed; status polls still answer Idle
        outcome, msg, secs = runner(sim, link, clock, ["G21", "G90", "M9"], log)[0].run()
        assert outcome == "failed" and "stopped answering" in msg and secs < 40

    def test_a_serial_drop_mid_job_fails_it_with_the_reason(self, log):
        sim, link, clock = make(log)
        sim.fail_write_after = 6
        outcome, msg, _ = runner(sim, link, clock, self.LINES, log)[0].run()
        assert outcome == "failed" and "Lost the link" in msg

    def test_stop_cancels_with_hold_then_reset_and_the_machine_then_needs_homing(self, log):
        sim, link, clock = make(log)
        r, _ = runner(sim, link, clock, self.LINES, log)
        r.stop()
        outcome, msg, _ = r.run()
        assert (outcome, msg) == ("cancelled", "Stopped") and sim.written[:2] == [b"!", b"\x18"] and sim.homed is False

    def test_pause_waits_for_hold_0_and_resume_carries_on(self, log):
        sim, link, clock = make(log)
        r, ev = runner(sim, link, clock, self.LINES, log)
        r.pause()
        assert r.paused and sim.written[0] == b"!"
        import threading

        sim_sleep = clock.sleep
        calls = {"n": 0}

        def sleep(s):  # after a few polls of the hold, press resume
            calls["n"] += 1
            if calls["n"] == 5:
                r.resume()
            sim_sleep(s)

        r.sleep = sleep
        outcome, _, _ = r.run()
        assert outcome == "done" and "Hold" in ev["states"] and b"~" in sim.written

    def test_pause_does_not_time_out_a_line_that_waits_for_its_ok(self, log):
        sim, link, clock = make(log)
        sim.hold_blocks_ok = True
        lines = ["G21", "G90", "G1 X5 Y5 S100 F900", "G1 X6 Y6", "M5"]
        r, _ = runner(sim, link, clock, lines, log)
        original = link.command
        state = {"paused_once": False}

        def command(line, **kw):
            if line == "G1 X6 Y6" and not state["paused_once"]:
                state["paused_once"] = True
                r.pause()
                import threading
                threading.Timer(0.0, r.resume).start()  # the hold ends later; the 15 s timeout must not have run out meanwhile
            return original(line, **kw)

        link.command = command
        assert r.run()[0] == "done"

    def test_bounds_describe_the_job_not_where_the_head_happened_to_start(self):
        s = gcode.scan("G21\nG90\nG0 X19.9 Y19.9\nG1 X70 Y19.9 S100 F900\nG1 X70 Y50", bed_w=400, bed_h=415, s30_max=1000)
        assert s.bounds == (19.9, 19.9, 70.0, 50.0) == s.cut_bounds

    def test_the_return_to_origin_at_the_end_is_on_the_bed_but_not_part_of_the_cut(self):
        s = gcode.scan("G21\nG90\nM4 S0\nG0 X19.9 Y19.9\nG1 X70 Y50 S100 F900\nM5\nG0 X0 Y0 S0", bed_w=400, bed_h=415, s30_max=1000)
        assert s.bounds == (0.0, 0.0, 70.0, 50.0) and s.cut_bounds == (19.9, 19.9, 70.0, 50.0)
