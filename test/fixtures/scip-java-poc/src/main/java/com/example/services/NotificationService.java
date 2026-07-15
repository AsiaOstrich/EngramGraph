package com.example.services;

// Control case: "notify" has exactly one definition project-wide, so
// tree-sitter's cross-file bare-name resolution succeeds unambiguously
// (globalIndex.get("notify").size === 1) even though the call site
// (Program.java) is a third file that defines neither notify nor its caller.
public class NotificationService {
    public void notify(String message) {
        System.out.println("[notify] " + message);
    }
}
