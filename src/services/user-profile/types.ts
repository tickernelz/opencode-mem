export interface UserProfilePreference {
  category: string;
  description: string;
  confidence: number;
  frequency: number;
  evidence: string[];
  lastSeen: number;
  centroid?: number[];
  anchor?: number[];
  weakHitCount?: number;
  lastWeakHitAt?: number;
  driftBelowCount?: number;
  alpha?: number;
  beta?: number;
  weakAlpha?: number;
  weakBeta?: number;
  pendingValidation?: boolean;
  lastMatchTime?: number;
  firstSeen?: number;
}

export interface UserProfilePattern {
  category: string;
  description: string;
  confidence: number;
  frequency: number;
  evidence: string[];
  lastSeen: number;
  centroid?: number[];
  anchor?: number[];
  weakHitCount?: number;
  lastWeakHitAt?: number;
  driftBelowCount?: number;
  alpha?: number;
  beta?: number;
  weakAlpha?: number;
  weakBeta?: number;
  pendingValidation?: boolean;
  lastMatchTime?: number;
  firstSeen?: number;
}

export interface UserProfileWorkflow {
  description: string;
  steps: string[];
  confidence: number;
  frequency: number;
  evidence: string[];
  lastSeen: number;
  centroid?: number[];
  anchor?: number[];
  weakHitCount?: number;
  lastWeakHitAt?: number;
  driftBelowCount?: number;
  alpha?: number;
  beta?: number;
  weakAlpha?: number;
  weakBeta?: number;
  pendingValidation?: boolean;
  lastMatchTime?: number;
  firstSeen?: number;
}

export interface UserProfileData {
  preferences: UserProfilePreference[];
  patterns: UserProfilePattern[];
  workflows: UserProfileWorkflow[];
  learning_paths?: { topic: string; chain: string[]; description: string }[];
}

export interface UserProfile {
  id: string;
  userId: string;
  displayName: string;
  userName: string;
  userEmail: string;
  profileData: string;
  version: number;
  createdAt: number;
  lastAnalyzedAt: number;
  totalPromptsAnalyzed: number;
  isActive: boolean;
}

export interface UserProfileChangelog {
  id: string;
  profileId: string;
  version: number;
  changeType: string;
  changeSummary: string;
  profileDataSnapshot: string;
  createdAt: number;
}
