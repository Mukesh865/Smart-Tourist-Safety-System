from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlmodel import Session

from .config import settings
from .db import get_session
from .models import Role, User

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode()[:72], bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    return bcrypt.checkpw(pw.encode()[:72], hashed.encode())


def create_token(user: User) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_minutes)
    return jwt.encode(
        {"sub": str(user.id), "role": user.role.value, "tv": user.token_version or 0, "exp": exp},
        settings.secret_key,
        algorithm=settings.algorithm,
    )


def current_user(token: str = Depends(oauth2), session: Session = Depends(get_session)) -> User:
    err = HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    try:
        data = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        user = session.get(User, int(data["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError):
        raise err
    if not user or user.disabled:
        raise err
    if data.get("tv", 0) != (user.token_version or 0):   # password changed / logged out everywhere / role changed
        raise err
    return user


def require_roles(*roles: Role):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient role")
        return user

    return dep
