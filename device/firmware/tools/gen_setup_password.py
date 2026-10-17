import random, string
import sys

chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
pw = ''.join(random.choice(chars) for _ in range(8))

# Write raw password file (for reference)
with open('device/firmware/common/ap_password.txt', 'w') as f:
    f.write(pw)

# Write ESPHome YAML fragment with substitution
yaml_content = f'''# Auto-generated setup AP password.
# Regenerate with: python3 device/firmware/tools/gen_setup_password.py
# This password is used for the setup access point and displayed on screen / in QR code.
substitutions:
  setup_ap_password: "{pw}"
'''

with open('device/firmware/common/ap_password.yaml', 'w') as f:
    f.write(yaml_content)

print(f"Generated setup AP password: {pw}")
print("Written to device/firmware/common/ap_password.yaml")
print("Written to device/firmware/common/ap_password.txt")