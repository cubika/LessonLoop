"""Run the pinned official engine with the documented Schema compatibility fix."""
import hindsight_compat
hindsight_compat.install()
from hindsight_api.main import main
if __name__ == "__main__":
    main()
