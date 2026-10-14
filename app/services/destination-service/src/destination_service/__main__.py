import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "destination_service.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8081")),
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    main()
