namespace ScipPocSample.Services;

// Control case: "Notify" has exactly one definition project-wide, so
// tree-sitter's cross-file bare-name resolution succeeds unambiguously
// (globalIndex.get("Notify").size === 1) even though the call site
// (Program.cs) is a third file that defines neither Notify nor its caller.
public class NotificationService
{
    public void Notify(string message)
    {
        Console.WriteLine($"[notify] {message}");
    }
}
