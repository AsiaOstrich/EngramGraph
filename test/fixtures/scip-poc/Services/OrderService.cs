using ScipPocSample.Models;

namespace ScipPocSample.Services;

// R4 (XSPEC-333, dev-platform docs/CROSS-FILE-COVERAGE.md) documented that
// tree-sitter's bare-name CALLS resolution loses precision exactly when two
// classes each define a method with the same name — OrderService.Validate
// and UserService.Validate below are that deliberately-reproduced case.
public class OrderService
{
    // Same-file call: Process -> Validate resolves via the same-file map
    // (lexical shadowing wins over the ambiguous global name), so this edge
    // is NOT part of the ambiguous case — it is the "tree-sitter already
    // gets this right" control.
    public void Process(Order order)
    {
        if (Validate(order))
        {
            order.Total += 1;
        }
    }

    public bool Validate(Order order)
    {
        return order.Id > 0;
    }
}
