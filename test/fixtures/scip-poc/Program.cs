using ScipPocSample.Models;
using ScipPocSample.Services;

namespace ScipPocSample;

// NOTE: deliberately a classic `class Program { static void Main }` entry
// point, not C#'s top-level-statements shorthand. Verified empirically
// (via collectExtraction) that tree-sitter's cross-file CALLS resolver only
// records a call when it has an *enclosing function* (a method/constructor/
// local-function node containing the call site) — C# top-level statements
// sit directly under compilation_unit with no such enclosing node, so calls
// made from a top-level-statement Program.cs are dropped before ambiguity
// resolution ever runs (silently invisible, not counted as "ambiguous").
// Wrapping the calls in Main() gives them a real enclosing Function node so
// the ambiguous-name cross-file resolution path (extractProject's
// globalIndex.size > 1 branch) is actually exercised, matching what R4
// measured against real-world code (Newtonsoft.Json is all classic
// class/method bodies, not top-level statements).
public class Program
{
    public static void Main(string[] args)
    {
        var order = new Order { Id = 1, Total = 10 };
        var user = new User { Name = "Ada" };

        var orderService = new OrderService();
        var userService = new UserService();
        var notificationService = new NotificationService();

        // Ambiguous case (R4): both OrderService and UserService define
        // "Validate". This call site is in a THIRD file (Program.cs), which
        // defines neither class's Validate, so tree-sitter's cross-file
        // resolver finds two global candidates for the bare name "Validate"
        // and drops the call as ambiguous (precision over recall) instead of
        // guessing. A real compiler (Roslyn, via scip-dotnet) knows
        // orderService's static type is OrderService and resolves this
        // correctly to OrderService.Validate.
        if (orderService.Validate(order))
        {
            orderService.Process(order);
        }

        // Same ambiguous shape, resolves to UserService.Validate under real
        // typing.
        if (userService.Validate(user))
        {
            userService.Register(user);
        }

        // Control case: unambiguous cross-file call (only one "Notify").
        notificationService.Notify("done");

        // Overload case: Calculator.Add(int,int) and Calculator.Add(double,double)
        // both live in ONE class — tree-sitter's bare-name resolution finds
        // exactly one *name* globally ("Add") and resolves it (no ambiguity
        // from tree-sitter's point of view, since ambiguity there is about
        // multiple *ids*, not multiple overloads sharing one id), but the two
        // overloads collapse onto the same Function node id regardless.
        var calculator = new Calculator();
        var intSum = calculator.Add(1, 2);
        var doubleSum = calculator.Add(1.5, 2.5);
        notificationService.Notify($"{intSum}/{doubleSum}");
    }
}
