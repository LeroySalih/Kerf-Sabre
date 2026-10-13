import json
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = {"job": "job.schema.json", "preset": "preset.schema.json", "machine": "machine-profile.schema.json"}


def load(path):
    return json.loads(Path(path).read_text())


@pytest.mark.parametrize("name", SCHEMAS)
def test_schema_is_valid_and_versioned(name):
    schema = load(ROOT / SCHEMAS[name])
    Draft202012Validator.check_schema(schema)
    assert schema["properties"]["schemaVersion"]["const"] == changelog_version()


def changelog_version():
    for line in (ROOT / "CHANGELOG.md").read_text().splitlines():
        if line.startswith("## "):
            return line.split()[1]


@pytest.mark.parametrize("name,file", [("job", "job.json"), ("preset", "preset.json"), ("machine", "machine-profile.json")])
def test_valid_examples(name, file):
    Draft202012Validator(load(ROOT / SCHEMAS[name])).validate(load(ROOT / "examples/valid" / file))


@pytest.mark.parametrize("path", sorted((ROOT / "examples/invalid").glob("*.json")), ids=lambda p: p.stem)
def test_invalid_examples(path):
    key = {"job": "job", "preset": "preset", "machine": "machine"}[path.stem.split("-")[0]]
    validator = Draft202012Validator(load(ROOT / SCHEMAS[key]))
    assert list(validator.iter_errors(load(path))), f"{path.name} should be rejected"


@pytest.mark.parametrize("path", sorted((ROOT / "machine-profiles").glob("*.json")), ids=lambda p: p.stem)
def test_placeholder_profiles(path):
    data = load(path)
    Draft202012Validator(load(ROOT / SCHEMAS["machine"])).validate(data)
    assert data["placeholder"] is True


def test_openapi_parses_and_refs_resolve():
    spec = yaml.safe_load((ROOT / "openapi.yaml").read_text())
    assert spec["openapi"].startswith("3.1")
    assert spec["info"]["version"] == changelog_version()
    text = (ROOT / "openapi.yaml").read_text()
    for ref in {s.split('"')[0] for s in text.split('$ref: "')[1:]}:
        if ref.startswith("./"):
            assert (ROOT / ref[2:]).exists(), ref
        else:
            node = spec
            for part in ref.lstrip("#/").split("/"):
                node = node[part]
