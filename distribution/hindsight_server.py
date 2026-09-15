"""Run the pinned official engine with the documented Schema compatibility fix."""
import os
os.environ["HINDSIGHT_API_OPERATION_VALIDATOR_EXTENSION"] = "hindsight_methods:PlaybookGuard"
os.environ["HINDSIGHT_API_ENABLE_MENTAL_MODEL_HISTORY"] = "false"
import hindsight_compat
hindsight_compat.install()
from hindsight_api.main import main
if __name__ == "__main__":
    main()
