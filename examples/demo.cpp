// Файл для демонстрации CppForge.
// 1) Поставьте курсор на пустую строку в area() → Ctrl/Cmd+Alt+S → выберите geo::ShapeKind.
// 2) Поставьте курсор внутрь switch в describe() → Ctrl/Cmd+Alt+C.
// 3) Поставьте курсор внутрь класса Student → Ctrl/Cmd+Alt+G.
#include <iostream>
#include <map>
#include <string>
#include <vector>
#include "shapes.h"

enum Weekday { Mon = 1, Tue, Wed, Thu, Fri, Sat, Sun };

class Student {
public:
    int getAge() const { return m_age; }

private:
    std::string m_name;
    int m_age = 18;
    const double m_gpa{4.0};
    bool active_ = true;
    std::map<std::string, std::vector<int>> grades_;
    static int s_count;
};

double area(geo::ShapeKind kind, double a) {

    return a;
}

const char* describe(Weekday d) {
    switch (d) {
        case Sat:
        case Sun:
            return "выходной";
        default:
            return "?";
    }
}

int main() {
    std::cout << describe(Mon) << "\n";
}
