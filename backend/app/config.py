from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="TS_")

    env: str = "dev"  # set TS_ENV=production for real deployments (enables startup safety checks)
    secret_key: str = "dev-secret-change-me-in-production-0123456789"
    admin_password: str = "Admin@12345"  # initial admin password; must be changed in production
    rate_limit_enabled: bool = True
    algorithm: str = "HS256"
    access_token_minutes: int = 60 * 8
    database_url: str = "sqlite:///./tourist_safety.db"
    keys_dir: str = "./keys"
    models_dir: str = "./models"
    detection_interval_s: int = 60  # 0 disables the background scheduler (tests)
    demo_enabled: bool = True  # demo/simulator endpoints; turn off for real deployments
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]


DEFAULT_SECRET = "dev-secret-change-me-in-production-0123456789"
DEFAULT_ADMIN_PASSWORD = "Admin@12345"


def production_problems(s: "Settings") -> list[str]:
    """Things that must not ship to production. Empty list = OK (or not in production)."""
    if s.env != "production":
        return []
    out = []
    if s.secret_key == DEFAULT_SECRET or len(s.secret_key) < 32:
        out.append("TS_SECRET_KEY must be set to a random value of at least 32 characters")
    if s.admin_password == DEFAULT_ADMIN_PASSWORD:
        out.append("TS_ADMIN_PASSWORD must be changed from the default")
    if s.demo_enabled:
        out.append("TS_DEMO_ENABLED must be false (demo accounts have a published password)")
    if s.database_url.startswith("sqlite"):
        out.append("SQLite is for development; set TS_DATABASE_URL to a server database")
    return out


settings = Settings()
