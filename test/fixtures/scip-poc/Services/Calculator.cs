namespace ScipPocSample.Services;

// Genuine C# method overloading (same class, same name, different parameter
// list) — distinct from the OrderService/UserService "different classes,
// same method name" ambiguous case above. extractor.ts's own doc comment
// (XSPEC-333 R2b) documents that tree-sitter's scope-qualified id scheme
// (`file#Class.Method`) does not disambiguate by signature, so both
// overloads below collapse onto the SAME Function node id
// (`Services/Calculator.cs#Calculator.Add`) — a known, pre-existing,
// documented tree-sitter limitation, not something this PoC introduces.
// Used to check whether the SCIP-side id-normalization reproduces the same
// collapse (SCIP's symbol strings differ only by a trailing disambiguator,
// e.g. `Add().` vs `Add(+1).` — stripping it should make both collapse onto
// the same canonical id too, matching tree-sitter rather than diverging
// from it).
public class Calculator
{
    public int Add(int a, int b)
    {
        return a + b;
    }

    public double Add(double a, double b)
    {
        return a + b;
    }
}
