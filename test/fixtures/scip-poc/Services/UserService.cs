using ScipPocSample.Models;

namespace ScipPocSample.Services;

public class UserService
{
    public void Register(User user)
    {
        if (Validate(user))
        {
            user.Name = user.Name.Trim();
        }
    }

    public bool Validate(User user)
    {
        return !string.IsNullOrWhiteSpace(user.Name);
    }
}
