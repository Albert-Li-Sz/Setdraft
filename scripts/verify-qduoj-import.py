"""Execute the pinned QDUOJ parser and serializer classes without its web server.

Only database-backed options are supplied from that commit's language catalog.
Parser, field validators, serializer declarations and test-data writer are upstream code.
"""
import ast
import importlib.util
import json
import pathlib
import sys
import tempfile
from types import SimpleNamespace

from django.conf import settings
from rest_framework import serializers

settings.configure(USE_I18N=False, SECRET_KEY="contract-test-only")
source, fps_file = map(pathlib.Path, sys.argv[1:])


def execute_selected(path, names, namespace):
    tree = ast.parse(path.read_text(), filename=str(path))
    nodes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in names]
    assert {node.name for node in nodes} == set(names), "Pinned importer classes missing"
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), namespace)


language_tree = ast.parse((source / "languages.py").read_text())
language_tree.body = [node for node in language_tree.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
catalog = {"ProblemIOMode": SimpleNamespace(standard="Standard IO", file="File IO")}
exec(compile(language_tree, str(source / "languages.py"), "exec"), catalog)
options = SimpleNamespace(spj_language_names=[item["name"] for item in catalog["languages"] if "spj" in item])
namespace = {"serializers": serializers, "SysOptions": options}
execute_selected(source / "utils-serializers.py", ["InvalidLanguage", "SPJLanguageNameChoiceField"], namespace)
execute_selected(source / "serializers.py", ["CreateSampleSerializer", "SPJSerializer", "FPSProblemSerializer"], namespace)
spec = importlib.util.spec_from_file_location("pinned_fps_parser", source / "parser.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
problems = module.FPSParser(str(fps_file)).parse()
assert problems, "No imported problems"
for problem in problems:
    serializer = namespace["FPSProblemSerializer"](data=problem)
    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["input"] and serializer.validated_data["output"]
    with tempfile.TemporaryDirectory(prefix="setdraft-fps-import-") as directory:
        info = module.FPSHelper().save_test_case(problem, directory)
        assert len(info["test_cases"]) == len(problem["test_cases"])
        for item in info["test_cases"].values():
            assert (pathlib.Path(directory) / item["input_name"]).is_file()
            assert (pathlib.Path(directory) / item["input_name"]).stat().st_size > 0
print(json.dumps({"importer": "QDUOJ", "commit": "df873278ab1b29510aa3a0979677d7aa9a53ca0e", "problems": len(problems), "validated": True}))
