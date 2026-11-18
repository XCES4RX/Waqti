using System.Security.Cryptography;
using System.Text;

namespace Waqti.Core.Security;

/// <summary>
/// Provides DPAPI (Data Protection API) hardware/OS-level encryption for sensitive tokens, keys, and configuration.
/// Only processes on this machine with Administrator or LocalSystem authority can decrypt protected secrets.
/// </summary>
public static class DataEncryptor
{
    private static readonly byte[] Entropy = "Waqti_Protected_Secret_Entropy_v1"u8.ToArray();
    private const string EncryptedPrefix = "enc:v1:";

    public static string Protect(string plainText)
    {
        if (string.IsNullOrEmpty(plainText)) return plainText;
        if (plainText.StartsWith(EncryptedPrefix)) return plainText;

        try
        {
            var plainBytes = Encoding.UTF8.GetBytes(plainText);
            var cipherBytes = ProtectedData.Protect(plainBytes, Entropy, DataProtectionScope.LocalMachine);
            return EncryptedPrefix + Convert.ToBase64String(cipherBytes);
        }
        catch
        {
            return plainText;
        }
    }

    public static string Unprotect(string cipherText)
    {
        if (string.IsNullOrEmpty(cipherText)) return cipherText;
        if (!cipherText.StartsWith(EncryptedPrefix)) return cipherText;

        try
        {
            var base64 = cipherText.Substring(EncryptedPrefix.Length);
            var cipherBytes = Convert.FromBase64String(base64);
            var plainBytes = ProtectedData.Unprotect(cipherBytes, Entropy, DataProtectionScope.LocalMachine);
            return Encoding.UTF8.GetString(plainBytes);
        }
        catch
        {
            return cipherText;
        }
    }
}
