from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, Field
from sqlmodel import Session, select

from .. import ratelimit
from ..db import get_session
from ..models import Role, Tourist, User
from ..security import create_token, current_user, hash_password, require_roles, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterIn(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=8, max_length=72)


class StaffIn(RegisterIn):
    role: Role


class UserOut(BaseModel):
    id: int
    email: str
    full_name: str
    role: Role
    language: str


def _create(session: Session, data: RegisterIn, role: Role) -> User:
    email = data.email.lower()
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(409, "Email already registered")
    user = User(email=email, full_name=data.full_name,
                password_hash=hash_password(data.password), role=role)
    session.add(user)
    session.commit()
    session.refresh(user)
    if role == Role.tourist:
        session.add(Tourist(user_id=user.id))
        session.commit()
    return user


@router.post("/register", response_model=UserOut, status_code=201)
def register(data: RegisterIn, request: Request, session: Session = Depends(get_session)):
    """Public self-registration always yields a tourist account."""
    ratelimit.check("register", ratelimit.client_ip(request), 10, 3600)
    return _create(session, data, Role.tourist)


@router.post("/staff", response_model=UserOut, status_code=201,
             dependencies=[Depends(require_roles(Role.admin))])
def create_staff(data: StaffIn, session: Session = Depends(get_session)):
    return _create(session, data, data.role)


@router.post("/login")
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), session: Session = Depends(get_session)):
    # throttle guessing per (address, account) and per address overall
    ratelimit.check("login", f"{ratelimit.client_ip(request)}:{form.username.lower()}", 8, 60)
    ratelimit.check("login-ip", ratelimit.client_ip(request), 60, 60)
    user = session.exec(select(User).where(User.email == form.username.lower())).first()
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
    if user.disabled:
        raise HTTPException(403, "This account has been disabled. Contact an administrator.")
    return {
        "access_token": create_token(user),
        "token_type": "bearer",
        "user": UserOut.model_validate(user, from_attributes=True),
    }


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


class ChangePasswordIn(BaseModel):
    current_password: str = Field(max_length=72)
    new_password: str = Field(min_length=8, max_length=72)


@router.post("/change-password")
def change_password(data: ChangePasswordIn, request: Request, user: User = Depends(current_user),
                    session: Session = Depends(get_session)):
    """Changes the password and signs out every other session (token version bump); returns a fresh token."""
    ratelimit.check("change-password", str(user.id), 10, 3600)
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    if data.current_password == data.new_password:
        raise HTTPException(400, "Choose a password different from the current one")
    user.password_hash = hash_password(data.new_password)
    user.token_version = (user.token_version or 0) + 1
    session.add(user)
    session.commit()
    session.refresh(user)
    return {"access_token": create_token(user), "token_type": "bearer"}


@router.post("/logout-all")
def logout_all(user: User = Depends(current_user), session: Session = Depends(get_session)):
    """Invalidate every token issued so far (all devices, including this one)."""
    user.token_version = (user.token_version or 0) + 1
    session.add(user)
    session.commit()
    return {"ok": True}
