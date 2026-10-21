"""The console shows every serial command and reply and every event, even with the log level at INFO."""
import io

from kerf_cutter.logs import CutterLog


def test_every_serial_line_and_event_is_echoed(tmp_path):
    out = io.StringIO()
    log = CutterLog(tmp_path, "station-1", "INFO", echo=out)
    log.add_secret("ks_secret")
    log.serial("TX", "G1 X10 Y10 S500")
    log.serial("RX", "ok")
    log.info("frame_start", job_id="job-1", bounds={"minX": 0})
    log.info("hello", token="ks_secret")
    text = out.getvalue().splitlines()
    assert text[0].endswith("TX G1 X10 Y10 S500") and text[1].endswith("RX ok")
    assert "frame_start" in text[2] and "job_id=job-1" in text[2]
    assert "ks_secret" not in out.getvalue() and "***" in text[3]
    # raw serial traffic at INFO stays out of the log file and the shipping queue
    assert not any(l["event"] == "serial" for l in log.recent) and not any(l["event"] == "serial" for l in log.ship)
    log.close()


def test_quiet_means_no_console_output(tmp_path):
    log = CutterLog(tmp_path, "station-1", "INFO")
    log.serial("TX", "G0 X0 Y0")
    log.info("x")
    log.close()
