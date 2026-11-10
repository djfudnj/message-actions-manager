# Message Actions Manager

<div align="center">
<img width="640" height="362" alt="1000313807" src="https://github.com/user-attachments/assets/5b88f848-ef73-49eb-8624-40c9d46c7bca" />
</div>


A SillyTavern extension to customize the visibility and order of message action icons.

Icons can be split into two groups: **Main**, which is always shown in the message header, and **More Plus**, which is only shown after clicking the `…` button. Everything is managed from the extension panel. Icons added by other extensions are detected automatically and appended to the end of the Main group.

<br> 

## Expand Message Actions

How this extension behaves depends on SillyTavern's *Expand Message Actions* user setting.

<div align="center">
<img width="334" height="34" alt="image" src="https://github.com/user-attachments/assets/c17987c7-a579-4799-bad0-d5fc3a755f64" />
</div>

- **ON**: The grouping feature is turned on. Icons are split into the Main group and the More Plus group, as described below. 
- **OFF**: Your theme's own message action styling is kept, and only the icon order and visibility are applied. The grouping feature is turned off.

<br> 

## Main Features

<div align="center">
<img width="50%" alt="Preview" src="https://github.com/user-attachments/assets/abf25b06-1952-44e7-871b-5b28bff8f998" />
</div>

### 0. Preview
Shows how the icons will look in an actual message. The left side is the Main group, and the right side is the More Plus group that unfolds when you click `…`. You can drag icons here to reorder them too.

### 1. Main Group
Always visible in the message. Use the handle on the left of each row to reorder.

### 2. More Plus Group
Tucked away behind the `…` button and shown only after you click it. Use the handle on the left of each row to reorder, or drag icons between the two groups. Grouping applies only when *Expand Message Actions* is ON.

### 3. Visibility
Uncheck **Show** to hide an icon from the message actions. Works whether *Expand Message Actions* is ON or OFF.


<br> 

## Extras

### 4. Remove shadows from message action icons
Removes shadows from the icons. (*Expand Message Actions* ON only)

### 5. Scroll icons sideways instead of wrapping to a new line
When there are too many icons, keeps them on one line and lets you scroll horizontally instead of wrapping. (*Expand Message Actions* ON only)

### 6. Clean Up
Removes leftover entries from extensions that have been uninstalled or disabled.
