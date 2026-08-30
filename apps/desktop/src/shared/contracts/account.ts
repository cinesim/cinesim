export interface AccountUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
}

export type AccountStatus = "signed-out" | "signed-in" | "offline";
export type SignInMethod = "email" | "google";

export interface AccountSnapshot {
  status: AccountStatus;
  cloudOrigin: string | null;
  serviceAvailable: boolean;
  googleSignIn: boolean;
  cloudStorage?: boolean;
  transcription: boolean;
  user: AccountUser | null;
  detail: string | null;
}

export interface RegisteredProject {
  id: string;
  clientProjectId: string;
  name: string;
}
