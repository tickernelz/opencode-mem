import type { UserProfileData } from "../../user-profile/types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  data?: UserProfileData;
}

export class UserProfileValidator {
  static validate(data: any): ValidationResult {
    const errors: string[] = [];
    if (!data || typeof data !== "object") {
      return { valid: false, errors: ["Response is not an object"] };
    }
    if (Array.isArray(data)) {
      return { valid: false, errors: ["Response cannot be an array"] };
    }
    const keys = Object.keys(data);
    if (keys.length === 0) {
      return { valid: false, errors: ["Response object is empty"] };
    }
    for (const key of keys) {
      if (data[key] === undefined || data[key] === null) {
        errors.push(`Field '${key}' is null or undefined`);
      }
    }
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    if (data.preferences) {
      const prefErrors = this.validatePreferences(data.preferences);
      errors.push(...prefErrors);
    }
    if (data.patterns) {
      const patternErrors = this.validatePatterns(data.patterns);
      errors.push(...patternErrors);
    }
    if (data.workflows) {
      const workflowErrors = this.validateWorkflows(data.workflows);
      errors.push(...workflowErrors);
    }
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    return { valid: true, errors: [], data: data as UserProfileData };
  }

  private static validatePreferences(preferences: any): string[] {
    const errors: string[] = [];
    if (!Array.isArray(preferences)) {
      return ["preferences must be an array"];
    }
    for (let i = 0; i < preferences.length; i++) {
      const pref = preferences[i];
      if (!pref || typeof pref !== "object") {
        errors.push(`preferences[${i}] is not an object`);
        continue;
      }
      if (!pref.category || typeof pref.category !== "string") {
        errors.push(`preferences[${i}].category is missing or invalid`);
      }
      if (!pref.description || typeof pref.description !== "string") {
        errors.push(`preferences[${i}].description is missing or invalid`);
      }
      if (
        typeof pref.confidence !== "number" ||
        !Number.isFinite(pref.confidence) ||
        pref.confidence < 0 ||
        pref.confidence > 1
      ) {
        errors.push(`preferences[${i}].confidence must be a finite number between 0 and 1`);
      }
      if (!Array.isArray(pref.evidence)) {
        errors.push(`preferences[${i}].evidence must be an array`);
      } else if (pref.evidence.length === 0) {
        errors.push(`preferences[${i}].evidence cannot be empty`);
      }
    }
    return errors;
  }

  private static validatePatterns(patterns: any): string[] {
    const errors: string[] = [];
    if (!Array.isArray(patterns)) {
      return ["patterns must be an array"];
    }
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      if (!pattern || typeof pattern !== "object") {
        errors.push(`patterns[${i}] is not an object`);
        continue;
      }
      if (!pattern.category || typeof pattern.category !== "string") {
        errors.push(`patterns[${i}].category is missing or invalid`);
      }
      if (!pattern.description || typeof pattern.description !== "string") {
        errors.push(`patterns[${i}].description is missing or invalid`);
      }
    }
    return errors;
  }

  private static validateWorkflows(workflows: any): string[] {
    const errors: string[] = [];
    if (!Array.isArray(workflows)) {
      return ["workflows must be an array"];
    }
    for (let i = 0; i < workflows.length; i++) {
      const workflow = workflows[i];
      if (!workflow || typeof workflow !== "object") {
        errors.push(`workflows[${i}] is not an object`);
        continue;
      }
      if (!workflow.description || typeof workflow.description !== "string") {
        errors.push(`workflows[${i}].description is missing or invalid`);
      }
      if (!Array.isArray(workflow.steps)) {
        errors.push(`workflows[${i}].steps must be an array`);
      } else if (workflow.steps.length === 0) {
        errors.push(`workflows[${i}].steps cannot be empty`);
      }
    }
    return errors;
  }
}
