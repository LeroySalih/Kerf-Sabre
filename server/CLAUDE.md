# server/ (BISAK Kerf Server)
Python, suggested stack FastAPI, PostgreSQL, ezdxf, shapely/pyclipper. Follow the clean-up pipeline order in brief section 7 (dedupe/merge before join). G-code per brief section 6: keep arcs as G2/G3, absolute only, no G92, S0 across tabs/travel. Schemas come from `shared/`. Type hints, pytest.
