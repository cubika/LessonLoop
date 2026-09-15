import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).parents[1] / "distribution"))
import integration

class RegistrationTests(unittest.TestCase):
    def test_registration_replay_preserves_other_entries_and_rejects_user_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); data = root / "data"; data.mkdir()
            home = root / "copilot"; home.mkdir(); project = root / "project"; project.mkdir()
            record = {"installationId": "fixture", "runtimeRoot": str(root / "runtime"), "dataRoot": str(data), "allowedRoots": [str(project)]}
            config_path = home / "mcp-config.json"
            config_path.write_text(json.dumps({"mcpServers": {"other": {"command": "other"}}, "custom": True}))
            self.assertEqual(integration.agent_action("install", record, root / "runtime", data, home)["status"], "registered")
            self.assertEqual(integration.agent_action("install", record, root / "runtime", data, home)["status"], "registered")
            config = json.loads(config_path.read_text()); self.assertIn("other", config["mcpServers"])
            config["mcpServers"]["lessonloop"]["command"] = "user-modified"
            config_path.write_text(json.dumps(config))
            with self.assertRaisesRegex(RuntimeError, "configuration changed"):
                integration.agent_action("remove", record, root / "runtime", data, home)
            hooks, mcp = integration.entries(record); config["mcpServers"]["lessonloop"] = mcp
            config_path.write_text(json.dumps(config))
            integration.agent_action("remove", record, root / "runtime", data, home)
            remaining = json.loads(config_path.read_text())
            self.assertEqual(remaining, {"mcpServers": {"other": {"command": "other"}}, "custom": True})
            self.assertFalse((home / "hooks/lessonloop.json").exists())

    def test_registration_requires_scope_and_does_not_replace_existing_hindsight(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); data=root/"data";data.mkdir();home=root/"copilot"
            record={"installationId":"test","runtimeRoot":str(root/"runtime"),"dataRoot":str(data),"allowedRoots":[]}
            with self.assertRaisesRegex(RuntimeError,"Choose a workspace"):
                integration.agent_action("install",record,root/"runtime",data,home)
            record["allowedRoots"]=[str(root/"work")]
            (home/"hooks").mkdir(parents=True);(home/"hooks/hindsight.json").write_text("{}")
            with self.assertRaisesRegex(RuntimeError,"Another Hindsight"):
                integration.agent_action("install",record,root/"runtime",data,home)
            self.assertEqual((home/"hooks/hindsight.json").read_text(),"{}")

if __name__ == "__main__": unittest.main()
